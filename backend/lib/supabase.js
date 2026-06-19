import { createClient } from '@supabase/supabase-js';
import ws from 'ws';

const client = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY,
    {
        realtime: { transport: ws }
    }
);

// .schema() at query time is compatible with all supabase-js v2 versions.
// Avoids the db.schema constructor option which varies by version.
const supabase = client.schema('utility');

export default supabase;
