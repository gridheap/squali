import postgres from 'postgres';
import {readFile} from 'node:fs/promises';
if(!process.env.DATABASE_URL)throw new Error('Set DATABASE_URL to the dedicated Weave PostgreSQL role; credentials stay in the environment.');
const sql=postgres(process.env.DATABASE_URL,{max:1});
try{await sql`CREATE SCHEMA IF NOT EXISTS weave`;await sql`SET search_path TO weave`;await sql.unsafe(await readFile('src/schema.sql','utf8'));console.log('Weave schema migration complete.');}finally{await sql.end();}
