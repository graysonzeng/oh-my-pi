<task-result id="{{id}}" agent="{{agentName}}" status="{{status}}"{{#if completionKind}} completionKind="{{completionKind}}"{{/if}} duration="{{duration}}">
{{#if meta}}<meta lines="{{meta.lineCount}}" size="{{meta.charSize}}" />{{/if}}
<verification status="{{verificationStatus}}" parent-accepted="false" user-accepted="unknown"{{#if integrateClassification}} classification="{{integrateClassification}}" action="{{integrateAction}}"{{/if}}>
Process completion is not verification or acceptance. Use the current workspace-bound evidence before integrating.
{{#if parentOwnsVerification}}The parent owns the remaining checks. Run only missing or stale checks after integration; do not return the child to repeat parent-owned verification.{{/if}}
{{#if integrateReasons}}Reasons: {{integrateReasons}}
{{/if}}{{#each pendingChecks}}- {{id}}: {{reason}}
{{/each}}</verification>
{{#if abortReason}}
<abort-reason>{{abortReason}}{{#if resumable}} — the agent is still live with its full context; message it via `write agent://{{id}}` to resume instead of redoing the work.{{/if}}</abort-reason>
{{/if}}
{{#if error}}
<error>{{error}}</error>
{{/if}}
{{#if truncated}}
<preview full-output="agent://{{id}}">
{{preview}}
</preview>
{{else}}
<output>
{{preview}}
</output>
{{/if}}
{{#if mergeSummary}}
<merge-summary>
{{mergeSummary}}
</merge-summary>
{{/if}}
</task-result>
