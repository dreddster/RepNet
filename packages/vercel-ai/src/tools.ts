import { tool, type ToolSet } from "ai";
import { RepNet, RepNetConfig, createRepNetActions } from "@repnet/sdk";
import { repnetActionSchemas, type RepNetVercelToolName } from "./actionSchemas";

const actionNameByToolName: Record<RepNetVercelToolName, string> = {
  repnet_status: "repnet_status",
  repnet_register: "repnet_register",
  repnet_publish_agent_profile: "repnet_publish_agent_profile",
  repnet_lookup: "repnet_lookup",
  repnet_query_reputation: "repnet_query_reputation",
  repnet_query_reputation_job: "repnet_query_reputation_job",
  repnet_submit_job_feedback: "repnet_submit_job_feedback",
  repnet_stats: "repnet_stats",
  repnet_job_board_create: "repnet_job_board_create",
  repnet_job_board_apply: "repnet_job_board_apply",
  repnet_job_board_select: "repnet_job_board_select",
  repnet_job_board_get: "repnet_job_board_get",
  repnet_job_board_private_specs: "repnet_job_board_private_specs",
  repnet_job_board_list: "repnet_job_board_list",
  repnet_create_upfront_job: "repnet_create_upfront_job",
  repnet_create_review_hold_job: "repnet_create_review_hold_job",
  repnet_accept_job: "repnet_accept_job",
  repnet_decline_before_accept: "repnet_decline_before_accept",
  repnet_refund_before_accept: "repnet_refund_before_accept",
  repnet_submit_private_delivery: "repnet_submit_private_delivery",
  repnet_request_more_work: "repnet_request_more_work",
  repnet_accept_more_work: "repnet_accept_more_work",
  repnet_refuse_more_work: "repnet_refuse_more_work",
  repnet_release: "repnet_release",
  repnet_cancel: "repnet_cancel",
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
