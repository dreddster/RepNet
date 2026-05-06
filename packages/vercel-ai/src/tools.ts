import { tool, type ToolSet } from "ai";
import { RepNet, RepNetConfig, createRepNetActions } from "@repnet/sdk";
import { repnetActionSchemas, type RepNetVercelToolName } from "./actionSchemas";

const actionNameByToolName: Record<RepNetVercelToolName, string> = {
  repnet_status: "repnet_status",
  repnet_register: "repnet_register",
  repnet_publish_agent_profile: "repnet_publish_agent_profile",
  repnet_lookup: "repnet_lookup",
  repnet_evaluate_workers: "repnet_evaluate_workers",
  repnet_preview_payment: "repnet_preview_payment",
  repnet_pay: "repnet_pay",
  repnet_feedback: "repnet_feedback",
  repnet_submit_job_feedback: "repnet_submit_job_feedback",
  repnet_stats: "repnet_stats",
  repnet_publish_agreement: "repnet_publish_agreement",
  repnet_create_escrow: "repnet_create_escrow",
  // Preserve the Vercel package's historical public tool name while routing
  // behavior through the canonical SDK job-status action.
  repnet_get_job: "repnet_job_status",
  repnet_accept_job: "repnet_accept_job",
  repnet_deliver_work: "repnet_deliver_work",
  repnet_review_specs: "repnet_review_specs",
  repnet_accept_fail: "repnet_accept_fail",
  repnet_contest_spec: "repnet_contest_spec",
  repnet_submit_evidence: "repnet_submit_evidence",
  repnet_preview_escrow: "repnet_preview_escrow",
  repnet_job_status: "repnet_job_status",
};

/**
 * Create RepNet tools for the Vercel AI SDK.
 *
 * Usage:
 *   const tools = repnetTools({ chainId: 84532, signer: wallet });
 *   const { text } = await generateText({ model, tools, prompt: "..." });
 */
export function repnetTools(config: RepNetConfig): ToolSet {
  const client = new RepNet(config);
  const actions = createRepNetActions(client as any);

  return Object.fromEntries(
    (Object.keys(repnetActionSchemas) as RepNetVercelToolName[]).map((toolName) => {
      const action = actions[actionNameByToolName[toolName]];

      if (!action) {
        throw new Error(`Missing RepNet action for Vercel tool: ${toolName}`);
      }

      return [
        toolName,
        tool<Record<string, unknown>, string>({
          description: action.description,
          inputSchema: repnetActionSchemas[toolName] as any,
          execute: async (input) => action.execute(input),
        }),
      ];
    }),
  ) as ToolSet;
}
