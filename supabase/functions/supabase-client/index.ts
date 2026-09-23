// Supabase Edge Function - Shared Supabase Client
// Used by webhook and send-message functions

export const createClient = () => {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

  if (!supabaseUrl || !supabaseServiceRoleKey) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  }

  // Create a Supabase client using the native fetch API
  // For Edge Functions, we use the standard fetch-based approach
  return {
    supabaseUrl,
    supabaseServiceRoleKey,
    
    async query(table: string, method: string = 'GET', body?: any) {
      const headers = {
        'apikey': supabaseServiceRoleKey,
        'Authorization': `Bearer ${supabaseServiceRoleKey}`,
        'Content-Type': 'application/json',
      };

      const options: RequestInit = {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      };

      const url = `${supabaseUrl}/rest/v1/${table}`;
      const response = await fetch(url, options);

      if (!response.ok) {
        throw new Error(`Supabase query failed: ${response.status} ${response.statusText}`);
      }

      return response.json();
    },

    async get(table: string) {
      return this.query(table, 'GET');
    },

    async insert(table: string, data: any) {
      return this.query(table, 'POST', data);
    },

    async update(table: string, id: string, data: any) {
      const url = `${supabaseUrl}/rest/v1/${table}?id=eq.${id}`;
      const options: RequestInit = {
        method: 'PATCH',
        headers: {
          'apikey': supabaseServiceRoleKey,
          'Authorization': `Bearer ${supabaseServiceRoleKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(data),
      };
      const response = await fetch(url, options);
      return response.json();
    }
  };
};
