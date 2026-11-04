-- Executed by the isolated PostgreSQL bootstrap service as the database admin.
-- Passwords are passed as psql variables and quoted by format(), never interpolated by the shell.
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'app_user', :'app_password') \gexec
SELECT format('GRANT ALL PRIVILEGES ON DATABASE %I TO %I', current_database(), :'app_user') \gexec
SELECT format('GRANT USAGE, CREATE ON SCHEMA public TO %I', :'app_user') \gexec
