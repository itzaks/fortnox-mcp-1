import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { fortnoxRequest } from "../services/api.js";
import { ResponseFormat } from "../constants.js";
import {
  buildToolResponse,
  buildErrorResponse,
  formatListMarkdown,
  formatDetailMarkdown
} from "../services/formatters.js";

// Schemas
const ListInboxSchema = z.object({
  folder_path: z.string()
    .optional()
    .describe("Folder path to list. Use one of the static folder names: Inbox_s (Supplier invoices), Inbox_v (Vouchers), Inbox_kf (Customer invoices), Inbox_o (Orders), Inbox_of (Offers), Inbox_a (Asset register), Inbox_d (Daily takings), Inbox_b (Bank files), Inbox_l (Payroll files). Leave empty for root inbox."),
  response_format: z.nativeEnum(ResponseFormat)
    .default(ResponseFormat.MARKDOWN)
    .describe("Output format: 'markdown' or 'json'")
}).strict();

type ListInboxInput = z.infer<typeof ListInboxSchema>;

const GetInboxFileSchema = z.object({
  file_id: z.string()
    .describe("The ID of the file to retrieve information about"),
  response_format: z.nativeEnum(ResponseFormat)
    .default(ResponseFormat.MARKDOWN)
    .describe("Output format: 'markdown' or 'json'")
}).strict();

type GetInboxFileInput = z.infer<typeof GetInboxFileSchema>;

// API response types
interface InboxFile {
  "@url"?: string;
  ArchiveFileId?: string;
  Comments?: string;
  Id: string;
  Name: string;
  Path?: string;
  Size?: number;
}

interface InboxFolder {
  "@url"?: string;
  Id: string;
  Name: string;
}

interface InboxFolderResponse {
  Folder: {
    "@url"?: string;
    Email?: string;
    Files: InboxFile[];
    Folders: InboxFolder[];
    Id: string;
    Name: string;
  };
}

const FOLDER_DESCRIPTIONS: Record<string, string> = {
  "Inbox_a": "Asset register",
  "Inbox_d": "Daily takings",
  "Inbox_s": "Supplier invoices",
  "Inbox_v": "Vouchers",
  "Inbox_b": "Bank files",
  "Inbox_l": "Payroll files",
  "Inbox_kf": "Customer invoices",
  "Inbox_o": "Orders",
  "Inbox_of": "Offers"
};

function formatFileSize(bytes: number | undefined): string {
  if (bytes === undefined || bytes === null) return "-";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Register inbox tools for accessing documents in the Fortnox inbox
 */
export function registerInboxTools(server: McpServer): void {
  // List inbox contents
  server.registerTool(
    "fortnox_list_inbox",
    {
      title: "List Fortnox Inbox",
      description: `List files and folders in the Fortnox inbox (inkorg).

The inbox contains uploaded documents like receipts, supplier invoices, vouchers, etc.
organized in predefined folders:

  - Inbox_s: Supplier invoices (leverantörsfakturor)
  - Inbox_v: Vouchers (verifikationer)
  - Inbox_kf: Customer invoices (kundfakturor)
  - Inbox_o: Orders (ordrar)
  - Inbox_of: Offers (offerter)
  - Inbox_a: Asset register (anläggningsregister)
  - Inbox_d: Daily takings (dagskassor)
  - Inbox_b: Bank files (bankfiler)
  - Inbox_l: Payroll files (lönefiler)

Args:
  - folder_path (string, optional): Folder to list (e.g. 'Inbox_s'). Leave empty for root.
  - response_format ('markdown' | 'json'): Output format

Returns:
  List of files and subfolders in the specified inbox folder.`,
      inputSchema: ListInboxSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      }
    },
    async (params: ListInboxInput) => {
      try {
        let endpoint = "/3/inbox";
        const queryParams: Record<string, string> = {};

        if (params.folder_path) {
          queryParams.path = params.folder_path;
        }

        const response = await fortnoxRequest<InboxFolderResponse>(
          endpoint,
          "GET",
          undefined,
          queryParams
        );
        const folder = response.Folder;
        const files = folder.Files || [];
        const folders = folder.Folders || [];

        const output = {
          folder_name: folder.Name,
          folder_id: folder.Id,
          email: folder.Email || null,
          file_count: files.length,
          subfolder_count: folders.length,
          files: files.map((f) => ({
            id: f.Id,
            name: f.Name,
            size: f.Size || null,
            size_formatted: formatFileSize(f.Size),
            path: f.Path || null,
            comments: f.Comments || null,
            archive_file_id: f.ArchiveFileId || null
          })),
          subfolders: folders.map((sf) => ({
            id: sf.Id,
            name: sf.Name,
            description: FOLDER_DESCRIPTIONS[sf.Name] || null
          }))
        };

        let textContent: string;
        if (params.response_format === ResponseFormat.JSON) {
          textContent = JSON.stringify(output, null, 2);
        } else {
          const lines = [
            `# Inbox: ${folder.Name}`,
            ""
          ];

          if (folder.Email) {
            lines.push(`**Email for uploads:** ${folder.Email}`, "");
          }

          if (folders.length > 0) {
            lines.push("## Folders", "");
            lines.push("| Folder | Description |");
            lines.push("|--------|-------------|");
            for (const sf of folders) {
              const desc = FOLDER_DESCRIPTIONS[sf.Name] || "-";
              lines.push(`| ${sf.Name} | ${desc} |`);
            }
            lines.push("");
          }

          if (files.length > 0) {
            lines.push(`## Files (${files.length})`, "");
            lines.push("| Name | Size | ID |");
            lines.push("|------|------|----|");
            for (const f of files) {
              lines.push(`| ${f.Name} | ${formatFileSize(f.Size)} | ${f.Id} |`);
            }
          } else if (folders.length === 0) {
            lines.push("*No files or folders found.*");
          }

          textContent = lines.join("\n");
        }

        return buildToolResponse(textContent, output);
      } catch (error) {
        return buildErrorResponse(error);
      }
    }
  );

  // Get inbox file details
  server.registerTool(
    "fortnox_get_inbox_file",
    {
      title: "Get Inbox File Details",
      description: `Get details about a specific file in the Fortnox inbox.

Use fortnox_list_inbox first to find file IDs, then use this tool to get
more details about a specific file.

Args:
  - file_id (string): The ID of the file
  - response_format ('markdown' | 'json'): Output format

Returns:
  File details including name, size, path, and comments.`,
      inputSchema: GetInboxFileSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      }
    },
    async (params: GetInboxFileInput) => {
      try {
        // First, search for the file in the inbox to get its metadata
        // We check each folder for the file
        const rootResponse = await fortnoxRequest<InboxFolderResponse>("/3/inbox");
        const rootFolder = rootResponse.Folder;

        // Check root files first
        let foundFile: InboxFile | null = null;
        let foundIn = "Root";

        for (const f of rootFolder.Files || []) {
          if (f.Id === params.file_id) {
            foundFile = f;
            break;
          }
        }

        // Search subfolders if not found in root
        if (!foundFile) {
          for (const sf of rootFolder.Folders || []) {
            try {
              const subResponse = await fortnoxRequest<InboxFolderResponse>(
                "/3/inbox",
                "GET",
                undefined,
                { path: sf.Name }
              );
              for (const f of subResponse.Folder.Files || []) {
                if (f.Id === params.file_id) {
                  foundFile = f;
                  foundIn = `${sf.Name} (${FOLDER_DESCRIPTIONS[sf.Name] || sf.Name})`;
                  break;
                }
              }
              if (foundFile) break;
            } catch {
              // Skip folders that fail to load
            }
          }
        }

        if (!foundFile) {
          return buildToolResponse(
            `File with ID '${params.file_id}' not found in inbox.`,
            { error: "File not found", file_id: params.file_id }
          );
        }

        const output = {
          id: foundFile.Id,
          name: foundFile.Name,
          size: foundFile.Size || null,
          size_formatted: formatFileSize(foundFile.Size),
          path: foundFile.Path || null,
          comments: foundFile.Comments || null,
          archive_file_id: foundFile.ArchiveFileId || null,
          found_in_folder: foundIn
        };

        let textContent: string;
        if (params.response_format === ResponseFormat.JSON) {
          textContent = JSON.stringify(output, null, 2);
        } else {
          textContent = formatDetailMarkdown(`File: ${foundFile.Name}`, [
            { label: "ID", value: foundFile.Id },
            { label: "Name", value: foundFile.Name },
            { label: "Size", value: formatFileSize(foundFile.Size) },
            { label: "Folder", value: foundIn },
            { label: "Path", value: foundFile.Path },
            { label: "Comments", value: foundFile.Comments },
            { label: "Archive File ID", value: foundFile.ArchiveFileId }
          ]);
        }

        return buildToolResponse(textContent, output);
      } catch (error) {
        return buildErrorResponse(error);
      }
    }
  );
}
