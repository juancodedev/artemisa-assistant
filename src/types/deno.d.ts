// Declarations for Deno global types (used in Supabase Edge Functions)
declare namespace Deno {
  namespace env {
    function get(key: string): string | undefined;
  }
  function serve(handler: (req: Request) => Promise<Response> | Response): void;
}

