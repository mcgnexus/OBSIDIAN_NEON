-- Template: provision a restricted device role for one Obsidian installation.
-- Run as the trusted schema owner (neondb_owner) on the target branch.
-- Replace the placeholders before executing.

-- 1. Create the device role (change the password).
-- CREATE ROLE obsidian_device LOGIN PASSWORD 'CHANGE_ME_STRONG_PASSWORD';

-- 2. Map the role to the vault (use the vault UUID from neon_sync.vaults).
-- INSERT INTO neon_sync.device_access (role_name, vault_id)
-- VALUES ('obsidian_device', '00000000-0000-0000-0000-000000000000');

-- 3. Minimal grants: schema usage + execution of the seven public functions only.
-- GRANT USAGE ON SCHEMA neon_sync TO obsidian_device;
-- GRANT EXECUTE ON FUNCTION neon_sync.manifest() TO obsidian_device;
-- GRANT EXECUTE ON FUNCTION neon_sync.apply(jsonb, bigint) TO obsidian_device;
-- GRANT EXECUTE ON FUNCTION neon_sync.changes(bigint, integer) TO obsidian_device;
-- GRANT EXECUTE ON FUNCTION neon_sync.note(text) TO obsidian_device;
-- GRANT EXECUTE ON FUNCTION neon_sync.history(text, bigint) TO obsidian_device;
-- GRANT EXECUTE ON FUNCTION neon_sync.revision(text, bigint) TO obsidian_device;
-- GRANT EXECUTE ON FUNCTION neon_sync.cleanup() TO obsidian_device;

-- Do NOT grant SELECT/INSERT/UPDATE/DELETE on any table to the device role.
-- The functions are SECURITY DEFINER and run as the schema owner.

-- 4. Build the connection URL for the plugin (use the -pooler host for normal traffic):
-- postgresql://obsidian_device:PASSWORD@ep-XXXX-pooler.REGION.aws.neon.tech/neondb?sslmode=require&channel_binding=require
