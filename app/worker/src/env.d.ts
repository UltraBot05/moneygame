// SPIKE-003 secret bindings. Provided via `.dev.vars` locally and
// `wrangler secret put` in deployment — never committed. Declared here (as an
// ambient merge into the wrangler-generated `Env`) because secrets are not part
// of wrangler.toml `[vars]` and so are not emitted by `wrangler types`.
interface Env {
  GOOGLE_CLIENT_SECRET: string;
  SESSION_SECRET: string;
}
