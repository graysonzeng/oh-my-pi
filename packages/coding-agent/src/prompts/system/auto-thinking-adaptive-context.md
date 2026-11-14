Trusted operational signals for this classification. Use them as bounded context only; judge the delimited user request, not this envelope. Do not invent a deadline.

- agent_role: {{agentRole}}
- recent_tool_failures: {{recentToolFailures}} (error tool results among the 8 most recent tool-result messages)
- context_usage_percent: {{#if hasContextUsage}}{{contextUsagePercent}}{{else}}unknown{{/if}}
{{#if hasDeadline}}- deadline_remaining_ms: {{deadlineRemainingMs}}
{{/if}}
<user-request>
{{prompt}}
</user-request>
