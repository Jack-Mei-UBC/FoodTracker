import { Pool } from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config();

const connectionString = process.env.DATABASE_URL || 'postgresql://postgres:password@localhost:5432/foodtracker';

export const pool = new Pool({
  connectionString,
});

// Helper to query PostgreSQL
export const query = (text: string, params?: any[]) => pool.query(text, params);

// Initialize DB schema on startup
export async function initializeDatabase() {
  try {
    console.log('Checking database tables...');
    const tableCheck = await query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'foods'
      );
    `);

    const schemaExists = tableCheck.rows[0].exists;
    if (!schemaExists) {
      console.log('Foods table not found. Initializing schema from schema.sql...');
      // Read schema file
      const schemaPath = path.resolve(__dirname, '../../db/schema.sql');
      if (fs.existsSync(schemaPath)) {
        const schemaSql = fs.readFileSync(schemaPath, 'utf8');
        await query(schemaSql);
        console.log('Database initialized successfully with schema and seed data.');
      } else {
        // Fallback if schema.sql isn't relative in container build
        const backupSchemaPath = path.resolve(__dirname, '../schema.sql');
        if (fs.existsSync(backupSchemaPath)) {
          const schemaSql = fs.readFileSync(backupSchemaPath, 'utf8');
          await query(schemaSql);
          console.log('Database initialized successfully with backup schema.');
        } else {
          console.error('schema.sql not found! Database initialization skipped.');
        }
      }
    } else {
      console.log('Database tables already exist.');
    }
  } catch (error) {
    console.error('Error initializing database:', error);
  }
}
