# Style: structured-gpt

# Role: {{role}}

## Input
1. Plan: {{taskPlan}}
2. Requirements: {{requirements}}
3. Constraints: {{constraints}}

## Steps
1. Read relevant files using the read tool
2. Implement or analyze changes
3. Verify with bash when needed
4. Return structured output matching the schema

## Output Schema
{{outputSchema}}

Execute step-by-step. Do not skip verification when acceptance criteria require it.
