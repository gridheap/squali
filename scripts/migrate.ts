import postgres from 'postgres';
import {readFile} from 'node:fs/promises';
if(!process.env.DATABASE_URL)throw new Error('Set DATABASE_URL to the dedicated Squali PostgreSQL role; credentials stay in the environment.');
const sql=postgres(process.env.DATABASE_URL,{max:1});
try{const [{role,database}]=await sql`SELECT current_user AS role,current_database() AS database`;await sql`ALTER ROLE ${sql(role)} IN DATABASE ${sql(database)} SET search_path TO weave`;await sql`CREATE SCHEMA IF NOT EXISTS weave`;await sql`SET search_path TO weave`;await sql.unsafe(await readFile('src/schema.sql','utf8'));console.log('Squali schema migration complete.');}finally{await sql.end();}
