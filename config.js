// Higgins-Designs time tracking - connection config.
//
// These two values are safe to ship in the browser: the publishable key only
// grants what Row Level Security allows, and every timetrack table denies
// anon outright. Real access comes from signing in.
//
// The service_role key must NEVER appear in this file or anywhere under web/.

export const SUPABASE_URL = "https://oglemgegrdusgacscmqv.supabase.co";
export const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_Uf1mA5W2rQjs9tDAZDYr3Q_NnYu2r2d";

// Tables live in their own schema so Practice Manager can adopt them later
// without colliding with its own `public` tables.
export const DB_SCHEMA = "timetrack";
