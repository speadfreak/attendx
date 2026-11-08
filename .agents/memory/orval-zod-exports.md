---
name: Orval Zod exports
description: Avoid duplicate exports when regenerating the shared OpenAPI Zod package.
---

The Orval split Zod output generates runtime validators and TypeScript models with overlapping names. Keep the public barrel focused on the runtime validators used by API routes; wildcard-exporting both generated surfaces triggers duplicate-export compiler errors.

**Why:** The API server imports validator values by name, while generated client hooks carry their own response types. Re-exporting both is unnecessary and can make the API typecheck fail immediately after codegen.

**How to apply:** After `api-spec` codegen, inspect `lib/api-zod/src/index.ts`. If Orval restores wildcard exports for both `generated/api` and `generated/types`, remove the conflicting type wildcard or explicitly export only non-overlapping types, then run the shared TypeScript build.
