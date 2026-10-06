\set ON_ERROR_STOP on
-- Run only against the local development Postgres service as its administrator.
SELECT 'CREATE DATABASE kivro_resource_fixture'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'kivro_resource_fixture') \gexec
\connect kivro_resource_fixture

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kivro_resource_reader') THEN
    CREATE ROLE kivro_resource_reader LOGIN;
  END IF;
END $$;
ALTER ROLE kivro_resource_reader WITH LOGIN PASSWORD 'kivro_resource_local_only'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT CONNECTION LIMIT 4;
ALTER ROLE kivro_resource_reader SET default_transaction_read_only = on;
ALTER ROLE kivro_resource_reader SET statement_timeout = '2s';
ALTER ROLE kivro_resource_reader SET lock_timeout = '1s';
ALTER ROLE kivro_resource_reader SET search_path = pg_catalog;

REVOKE ALL ON DATABASE kivro_resource_fixture FROM PUBLIC;
GRANT CONNECT ON DATABASE kivro_resource_fixture TO kivro_resource_reader;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
CREATE SCHEMA IF NOT EXISTS resource_fixture;
REVOKE ALL ON SCHEMA resource_fixture FROM PUBLIC;
GRANT USAGE ON SCHEMA resource_fixture TO kivro_resource_reader;

CREATE TABLE IF NOT EXISTS resource_fixture.table_a (id text PRIMARY KEY, name text NOT NULL);
CREATE TABLE IF NOT EXISTS resource_fixture.table_b (id text PRIMARY KEY, secret text NOT NULL);
REVOKE ALL ON ALL TABLES IN SCHEMA resource_fixture FROM PUBLIC, kivro_resource_reader;
GRANT SELECT ON resource_fixture.table_a TO kivro_resource_reader;
INSERT INTO resource_fixture.table_a (id, name) VALUES ('a1', 'Allowed company'), ('a2', 'Second company'), ('large', repeat('x', 8192))
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name;
INSERT INTO resource_fixture.table_b (id, secret) VALUES ('b1', 'Not approved')
ON CONFLICT (id) DO UPDATE SET secret = EXCLUDED.secret;
