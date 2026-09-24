// Declarations for Deno global types (used in Supabase Edge Functions)
declare namespace Deno {
  interface Env {
    get(key: string): string | undefined;
    set(key: string, value: string): void;
    ["delete"](key: string): void;
  }

  const env: Env;
  function serve(handler: (req: Request) => Promise<Response> | Response): void;
  function test(name: string, fn: () => void | Promise<void>): void;
}

interface ImportMeta {
  main: boolean;
}
