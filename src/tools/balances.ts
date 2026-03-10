import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { fortnoxRequest } from "../services/api.js";
import { ResponseFormat } from "../constants.js";
import {
  buildToolResponse,
  buildErrorResponse,
  formatMoney,
} from "../services/formatters.js";

// Schemas
const GetBalancesSchema = z.object({
  account_numbers: z.array(z.number().int().min(1000).max(9999))
    .min(1)
    .max(50)
    .describe("Account numbers to get balances for (e.g. [1930, 1630])"),
  financial_year: z.number().int().min(1).optional()
    .describe("Financial year ID (from fortnox_list_accounts). Omit for current year."),
  response_format: z.nativeEnum(ResponseFormat)
    .default(ResponseFormat.MARKDOWN)
    .describe("Output format: 'markdown' or 'json'")
}).strict();

type GetBalancesInput = z.infer<typeof GetBalancesSchema>;

const FinancialOverviewSchema = z.object({
  financial_year: z.number().int().min(1).optional()
    .describe("Financial year ID. Omit for current year."),
  response_format: z.nativeEnum(ResponseFormat)
    .default(ResponseFormat.MARKDOWN)
    .describe("Output format: 'markdown' or 'json'")
}).strict();

type FinancialOverviewInput = z.infer<typeof FinancialOverviewSchema>;

// API types
interface FortnoxAccount {
  Number: number;
  Description: string;
  Active?: boolean;
  BalanceBroughtForward?: number;
  BalanceCarriedForward?: number;
  Year?: number;
}

interface AccountResponse {
  Account: FortnoxAccount;
}

interface FinancialYear {
  Id: number;
  FromDate: string;
  ToDate: string;
  AccountingMethod?: string;
}

interface FinancialYearsResponse {
  FinancialYears: FinancialYear[];
}

let cachedCurrentYearId: number | null = null;

async function getCurrentFinancialYearId(): Promise<number | undefined> {
  if (cachedCurrentYearId) return cachedCurrentYearId;
  try {
    const response = await fortnoxRequest<FinancialYearsResponse>("/3/financialyears");
    const years = response.FinancialYears || [];
    const today = new Date().toISOString().slice(0, 10);
    const current = years.find(y => y.FromDate <= today && y.ToDate >= today);
    if (current) {
      cachedCurrentYearId = current.Id;
      return current.Id;
    }
    // Fallback: return the highest ID (most recent year)
    if (years.length > 0) {
      const latest = years.reduce((a, b) => (a.Id > b.Id ? a : b));
      cachedCurrentYearId = latest.Id;
      return latest.Id;
    }
  } catch {
    // Fall through — let Fortnox use its own default
  }
  return undefined;
}

async function fetchAccountBalance(
  accountNumber: number,
  financialYear?: number
): Promise<FortnoxAccount | null> {
  try {
    const yearId = financialYear ?? await getCurrentFinancialYearId();
    const params: Record<string, string | number | boolean | undefined> = {};
    if (yearId) params.financialyear = yearId;
    const response = await fortnoxRequest<AccountResponse>(
      `/3/accounts/${accountNumber}`, "GET", undefined, params
    );
    return response.Account;
  } catch {
    return null;
  }
}

/**
 * Register balance-related tools
 */
export function registerBalanceTools(server: McpServer): void {
  server.registerTool(
    "fortnox_get_balances",
    {
      title: "Get Account Balances",
      description: `Get opening and closing balances for specific Fortnox accounts.

Use this to check bank balance, tax account, or any account balance.

Common Swedish BAS accounts:
  - 1630: Skattekonto (tax account)
  - 1910: Kassa (Cash)
  - 1920: Plusgiro
  - 1930: Företagskonto (main bank account)
  - 1940: Other bank accounts
  - 2440: Leverantörsskulder (accounts payable)

Args:
  - account_numbers (number[]): Account numbers to query (1-50 accounts)
  - financial_year (number): Financial year ID (omit for current year)
  - response_format ('markdown' | 'json'): Output format

Returns:
  Opening balance, closing balance, and description for each account.
  Note: These are *booked* balances based on accounting entries, not live bank balances.`,
      inputSchema: GetBalancesSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      }
    },
    async (params: GetBalancesInput) => {
      try {
        const results = await Promise.all(
          params.account_numbers.map(num => fetchAccountBalance(num, params.financial_year))
        );

        const balances = results
          .filter((a): a is FortnoxAccount => a !== null)
          .map(a => ({
            account_number: a.Number,
            description: a.Description,
            opening_balance: a.BalanceBroughtForward ?? 0,
            closing_balance: a.BalanceCarriedForward ?? 0,
            financial_year_id: a.Year
          }));

        const notFound = params.account_numbers.filter(
          num => !balances.some(b => b.account_number === num)
        );

        const output = { balances, not_found: notFound.length > 0 ? notFound : undefined };

        let textContent: string;
        if (params.response_format === ResponseFormat.JSON) {
          textContent = JSON.stringify(output, null, 2);
        } else {
          const lines: string[] = ["## Account Balances\n"];
          for (const b of balances) {
            lines.push(`### ${b.account_number} — ${b.description}`);
            lines.push(`- **Opening balance:** ${formatMoney(b.opening_balance)}`);
            lines.push(`- **Closing balance:** ${formatMoney(b.closing_balance)}`);
            lines.push("");
          }
          if (notFound.length > 0) {
            lines.push(`*Accounts not found: ${notFound.join(", ")}*`);
          }
          textContent = lines.join("\n");
        }

        return buildToolResponse(textContent, output);
      } catch (error) {
        return buildErrorResponse(error);
      }
    }
  );

  server.registerTool(
    "fortnox_financial_overview",
    {
      title: "Financial Overview",
      description: `Get a quick financial overview of the company including bank balance,
tax account, revenue, and expenses.

Fetches balances for key accounts:
  - Bank/cash (1900-series)
  - Tax account / Skattekonto (1630)
  - Accounts receivable (1510)
  - Accounts payable (2440)
  - Revenue summary (3000-series)
  - Key expense accounts

No parameters needed — just call it for a snapshot.

Args:
  - financial_year (number): Financial year ID (omit for current year)
  - response_format ('markdown' | 'json'): Output format

Returns:
  Summary of key financial balances.
  Note: Balances are based on booked accounting entries.`,
      inputSchema: FinancialOverviewSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      }
    },
    async (params: FinancialOverviewInput) => {
      try {
        // Key accounts to fetch
        const keyAccounts = [
          1510, // Kundfordringar (accounts receivable)
          1630, // Skattekonto (tax account)
          1910, // Kassa
          1920, // Plusgiro
          1930, // Företagskonto (main bank)
          1940, // Övriga bankkonton
          2440, // Leverantörsskulder (accounts payable)
          2610, // Utgående moms 25%
          2620, // Utgående moms 12%
          2640, // Ingående moms
          2650, // Redovisning moms
          3010, // Försäljning varor
          3011, // Försäljning varor
          3040, // Försäljning tjänster
          3050, // Försäljning tjänster
          3740, // Öres- och kronutjämning
        ];

        // Fetch financial years info and all accounts in parallel
        const [yearResponse, ...accountResults] = await Promise.all([
          fortnoxRequest<FinancialYearsResponse>("/3/financialyears").catch(() => null),
          ...keyAccounts.map(num => fetchAccountBalance(num, params.financial_year))
        ]);

        const accounts = accountResults
          .filter((a): a is FortnoxAccount => a !== null && a.Active !== false);

        // Group by category
        const bankAccounts = accounts.filter(a => a.Number >= 1900 && a.Number <= 1999);
        const taxAccount = accounts.find(a => a.Number === 1630);
        const receivables = accounts.find(a => a.Number === 1510);
        const payables = accounts.find(a => a.Number === 2440);
        const vatAccounts = accounts.filter(a => a.Number >= 2610 && a.Number <= 2650);
        const revenueAccounts = accounts.filter(a => a.Number >= 3000 && a.Number <= 3999);

        const totalBank = bankAccounts.reduce((sum, a) => sum + (a.BalanceCarriedForward ?? 0), 0);
        const totalRevenue = revenueAccounts.reduce((sum, a) => sum + (a.BalanceCarriedForward ?? 0), 0);
        const totalVat = vatAccounts.reduce((sum, a) => sum + (a.BalanceCarriedForward ?? 0), 0);

        // Determine financial year info
        let yearInfo: { id: number; from: string; to: string } | undefined;
        if (yearResponse) {
          const years = yearResponse.FinancialYears || [];
          const targetId = params.financial_year || (accounts[0]?.Year);
          const year = targetId ? years.find(y => y.Id === targetId) : years[0];
          if (year) yearInfo = { id: year.Id, from: year.FromDate, to: year.ToDate };
        }

        const output = {
          financial_year: yearInfo,
          bank: {
            total: totalBank,
            accounts: bankAccounts.map(a => ({
              number: a.Number,
              description: a.Description,
              balance: a.BalanceCarriedForward ?? 0
            }))
          },
          tax_account: taxAccount ? {
            number: 1630,
            description: taxAccount.Description,
            balance: taxAccount.BalanceCarriedForward ?? 0
          } : null,
          accounts_receivable: receivables ? {
            number: 1510,
            balance: receivables.BalanceCarriedForward ?? 0
          } : null,
          accounts_payable: payables ? {
            number: 2440,
            balance: payables.BalanceCarriedForward ?? 0
          } : null,
          vat: {
            total: totalVat,
            accounts: vatAccounts.map(a => ({
              number: a.Number,
              description: a.Description,
              balance: a.BalanceCarriedForward ?? 0
            }))
          },
          revenue: {
            total: totalRevenue,
            accounts: revenueAccounts.map(a => ({
              number: a.Number,
              description: a.Description,
              balance: a.BalanceCarriedForward ?? 0
            }))
          }
        };

        let textContent: string;
        if (params.response_format === ResponseFormat.JSON) {
          textContent = JSON.stringify(output, null, 2);
        } else {
          const lines: string[] = ["## Financial Overview\n"];

          if (yearInfo) {
            lines.push(`**Financial year:** ${yearInfo.from} — ${yearInfo.to}\n`);
          }

          // Bank
          lines.push("### 🏦 Bank & Cash");
          lines.push(`**Total: ${formatMoney(totalBank)}**`);
          for (const a of bankAccounts) {
            lines.push(`- ${a.Number} ${a.Description}: ${formatMoney(a.BalanceCarriedForward)}`);
          }
          lines.push("");

          // Tax account
          if (taxAccount) {
            lines.push("### 📋 Skattekonto (Tax Account)");
            lines.push(`**${formatMoney(taxAccount.BalanceCarriedForward)}** *(booked balance, not live Skatteverket balance)*`);
            lines.push("");
          }

          // Receivables & Payables
          if (receivables || payables) {
            lines.push("### 💰 Receivables & Payables");
            if (receivables) lines.push(`- Kundfordringar (1510): ${formatMoney(receivables.BalanceCarriedForward)}`);
            if (payables) lines.push(`- Leverantörsskulder (2440): ${formatMoney(payables.BalanceCarriedForward)}`);
            lines.push("");
          }

          // VAT
          if (vatAccounts.length > 0) {
            lines.push("### 🧾 VAT / Moms");
            lines.push(`**Net VAT position: ${formatMoney(totalVat)}**`);
            for (const a of vatAccounts) {
              if (a.BalanceCarriedForward) {
                lines.push(`- ${a.Number} ${a.Description}: ${formatMoney(a.BalanceCarriedForward)}`);
              }
            }
            lines.push("");
          }

          // Revenue
          if (revenueAccounts.length > 0) {
            lines.push("### 📈 Revenue");
            lines.push(`**Total: ${formatMoney(totalRevenue)}** *(negative = income in Swedish accounting)*`);
            for (const a of revenueAccounts) {
              if (a.BalanceCarriedForward) {
                lines.push(`- ${a.Number} ${a.Description}: ${formatMoney(a.BalanceCarriedForward)}`);
              }
            }
            lines.push("");
          }

          textContent = lines.join("\n");
        }

        return buildToolResponse(textContent, output);
      } catch (error) {
        return buildErrorResponse(error);
      }
    }
  );
}
