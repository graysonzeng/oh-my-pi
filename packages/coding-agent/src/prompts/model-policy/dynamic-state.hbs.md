Turn/Stage: {{turnOrStageId}}

Unresolved:
{{#each unresolvedItems}}
- {{id}} ({{kind}}/{{status}})
{{else}}
- none
{{/each}}

Required artifacts:
{{#each requiredArtifacts}}
- {{kind}}: {{presence}}
{{else}}
- none tracked
{{/each}}

Verification:
{{#each verificationEvidence}}
- {{commandOrCheck}}: {{status}}
{{else}}
- none
{{/each}}

Scope: {{scopeStatus}}
