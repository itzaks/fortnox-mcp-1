import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import axios from "axios";
import { PDFParse } from "pdf-parse";
import { fortnoxRequest } from "../services/api.js";
import { getTokenProvider } from "../auth/index.js";
import { getCurrentUserId } from "../auth/context.js";
import { FORTNOX_API_BASE_URL, ResponseFormat } from "../constants.js";
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
    .describe("Folder ID to list. Use one of: inbox_s (Supplier invoices), inbox_v (Vouchers), inbox_kf (Customer invoices), inbox_o (Orders), inbox_of (Offers), inbox_a (Asset register), inbox_d (Daily takings), inbox_b (Bank files), inbox_l (Payroll files), inbox_lm (Simple payroll), inbox_ku (Receipts & expenses). Leave empty for root inbox."),
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

const DownloadInboxFileSchema = z.object({
  file_id: z.string()
    .describe("The ID (UUID) of the inbox file to download and read"),
}).strict();

type DownloadInboxFileInput = z.infer<typeof DownloadInboxFileSchema>;

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
  "inbox_a": "Anlägningsregister (Asset register)",
  "inbox_d": "Dagskassor (Daily takings)",
  "inbox_s": "Leverantörsfakturor (Supplier invoices)",
  "inbox_v": "Verifikationer (Vouchers)",
  "inbox_b": "Bankfiler (Bank files)",
  "inbox_l": "Lön (Payroll files)",
  "inbox_lm": "Enkel Lön (Simple payroll)",
  "inbox_ku": "Kvitto & Utlägg (Receipts & expenses)",
  "inbox_kf": "Kundfakturor (Customer invoices)",
  "inbox_o": "Ordrar (Orders)",
  "inbox_of": "Offerter (Offers)"
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

        if (params.folder_path) {
          endpoint = `/3/inbox/${params.folder_path.toLowerCase()}`;
        }

        const response = await fortnoxRequest<InboxFolderResponse>(
          endpoint
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
            description: FOLDER_DESCRIPTIONS[sf.Id] || null
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
              const desc = FOLDER_DESCRIPTIONS[sf.Id] || sf.Name;
              lines.push(`| ${sf.Id} (${sf.Name}) | ${desc} |`);
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
                `/3/inbox/${sf.Id}`
              );
              for (const f of subResponse.Folder.Files || []) {
                if (f.Id === params.file_id) {
                  foundFile = f;
                  foundIn = `${sf.Name} (${FOLDER_DESCRIPTIONS[sf.Id] || sf.Name})`;
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

  // Download and read inbox file contents
  server.registerTool(
    "fortnox_download_inbox_file",
    {
      title: "Download & Read Inbox File",
      description: `Download a file from the Fortnox inbox and extract its contents.

For PDFs: extracts text content (amounts, dates, VAT, etc.)
For images (jpg, png): returns the image for visual analysis.

Use fortnox_list_inbox first to find file IDs, then use this tool
to read the actual file contents.

Args:
  - file_id (string): The UUID of the file to download

Returns:
  Extracted text from PDFs, or the image content for image files.`,
      inputSchema: DownloadInboxFileSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      }
    },
    async (params: DownloadInboxFileInput) => {
      try {
        const tokenProvider = getTokenProvider();
        const userId = getCurrentUserId();
        const accessToken = await tokenProvider.getAccessToken(userId);

        const response = await axios({
          method: "GET",
          url: `${FORTNOX_API_BASE_URL}/3/inbox/${params.file_id}`,
          headers: {
            "Authorization": `Bearer ${accessToken}`,
            "Accept": "*/*",
          },
          responseType: "arraybuffer",
          timeout: 60000
        });

        const buffer = Buffer.from(response.data);
        const contentType = (response.headers["content-type"] || "").toLowerCase();
        const contentDisposition = response.headers["content-disposition"] || "";
        const filenameMatch = contentDisposition.match(/filename[^;=\n]*=(?:UTF-8''|"?)([^";\n]*)/i);
        const filename = filenameMatch ? decodeURIComponent(filenameMatch[1]) : `file_${params.file_id}`;

        // Image files: return as image content for visual analysis
        const imageTypes: Record<string, string> = {
          "image/jpeg": "image/jpeg",
          "image/jpg": "image/jpeg",
          "image/png": "image/png",
          "image/gif": "image/gif",
          "image/webp": "image/webp",
        };

        if (imageTypes[contentType]) {
          return {
            content: [
              { type: "text" as const, text: `## File: ${filename}\n\nImage file (${formatFileSize(buffer.length)}, ${contentType}). Visual content below:` },
              { type: "image" as const, data: buffer.toString("base64"), mimeType: imageTypes[contentType] }
            ]
          };
        }

        // PDF files: extract text
        if (contentType === "application/pdf" || filename.toLowerCase().endsWith(".pdf")) {
          const parser = new PDFParse({ data: buffer });
          const result = await parser.getText();
          const text = result.text.trim();
          const totalPages = result.total;
          await parser.destroy();

          if (!text) {
            return {
              content: [
                { type: "text" as const, text: `## File: ${filename}\n\nPDF file (${totalPages} pages, ${formatFileSize(buffer.length)}) — no extractable text found. This PDF likely contains scanned images.\n\nReturning as image for visual analysis:` },
                { type: "image" as const, data: buffer.toString("base64"), mimeType: "application/pdf" }
              ]
            };
          }

          return {
            content: [
              { type: "text" as const, text: `## File: ${filename}\n\n**Pages:** ${totalPages} | **Size:** ${formatFileSize(buffer.length)}\n\n### Extracted text:\n\n${text}` }
            ]
          };
        }

        // Other text-based files
        if (contentType.includes("text/") || contentType.includes("xml") || contentType.includes("json")) {
          return {
            content: [
              { type: "text" as const, text: `## File: ${filename}\n\n\`\`\`\n${buffer.toString("utf-8")}\n\`\`\`` }
            ]
          };
        }

        // Unknown type: return basic info
        return {
          content: [
            { type: "text" as const, text: `## File: ${filename}\n\nFile type: ${contentType}\nSize: ${formatFileSize(buffer.length)}\n\nUnsupported file type for content extraction.` }
          ]
        };
      } catch (error) {
        return buildErrorResponse(error);
      }
    }
  );
}
