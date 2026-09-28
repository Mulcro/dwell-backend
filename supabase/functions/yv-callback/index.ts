import { handleYvCallback } from "./handler.ts";

Deno.serve((req) => handleYvCallback(req));
