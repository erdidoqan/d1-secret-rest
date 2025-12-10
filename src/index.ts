import { Hono, Context, Next } from "hono";
import { cors } from "hono/cors";
import { handleRest } from './rest';

export interface Env {
    API_TOKEN: string;  // Normal secret olarak tanımlandı
    // Dinamik D1 veritabanları - [key: string] formatında
    [key: string]: D1Database | string | unknown;
}

// # List all users from specific database
// GET /db/mydb/rest/users

// # Get filtered and sorted users
// GET /db/mydb/rest/users?age=25&sort_by=name&order=desc

// # Get paginated results
// GET /db/mydb/rest/users?limit=10&offset=20

// # Create a new user
// POST /db/mydb/rest/users
// { "name": "John", "age": 30 }

// # Update a user
// PATCH /db/mydb/rest/users/123
// { "age": 31 }

// # Delete a user
// DELETE /db/mydb/rest/users/123

// # Execute raw SQL query
// POST /db/mydb/query
// { "query": "SELECT * FROM users", "params": [] }

/**
 * Verilen binding adına göre D1 veritabanını döndürür
 */
function getDatabase(env: Env, dbName: string): D1Database | null {
    const db = env[dbName];
    if (db && typeof db === 'object' && 'prepare' in db) {
        return db as D1Database;
    }
    return null;
}

/**
 * Env'deki tüm D1 veritabanı binding isimlerini döndürür
 */
function getAvailableDatabases(env: Env): string[] {
    return Object.keys(env).filter(key => {
        const value = env[key];
        return value && typeof value === 'object' && 'prepare' in value;
    });
}

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        const app = new Hono<{ Bindings: Env }>();

        // Apply CORS to all routes
        app.use('*', async (c, next) => {
            return cors()(c, next);
        })

        // Secret değeri (normal secret olarak)
        const secret = env.API_TOKEN;

        // Authentication middleware that verifies the Authorization header
        // is sent in on each request and matches the value of our Secret key.
        // If a match is not found we return a 401 and prevent further access.
        const authMiddleware = async (c: Context, next: Next) => {
            const authHeader = c.req.header('Authorization');
            if (!authHeader) {
                return c.json({ error: 'Unauthorized' }, 401);
            }

            const token = authHeader.startsWith('Bearer ')
                ? authHeader.substring(7)
                : authHeader;

            if (token !== secret) {
                return c.json({ error: 'Unauthorized' }, 401);
            }

            return next();
        };

        // Database middleware - veritabanını context'e ekler
        const dbMiddleware = async (c: Context, next: Next) => {
            const dbName = c.req.param('dbName');
            
            if (!dbName) {
                return c.json({ error: 'Database name is required' }, 400);
            }

            const db = getDatabase(c.env, dbName);
            
            if (!db) {
                const available = getAvailableDatabases(c.env);
                return c.json({ 
                    error: `Database '${dbName}' not found`,
                    available_databases: available
                }, 404);
            }

            // Veritabanını context'e kaydet
            c.set('db', db);
            c.set('dbName', dbName);
            
            return next();
        };

        // Mevcut veritabanlarını listele
        app.get('/databases', authMiddleware, async (c) => {
            const databases = getAvailableDatabases(c.env);
            return c.json({ 
                success: true,
                databases 
            });
        });

        // CRUD REST endpoints - veritabanı adı ile
        app.all('/db/:dbName/rest/*', authMiddleware, dbMiddleware, handleRest);

        // Execute a raw SQL statement with parameters - veritabanı adı ile
        app.post('/db/:dbName/query', authMiddleware, dbMiddleware, async (c) => {
            try {
                const db = c.get('db') as D1Database;
                const body = await c.req.json();
                const { query, params } = body;

                if (!query) {
                    return c.json({ error: 'Query is required' }, 400);
                }

                // Execute the query against D1 database
                const results = await db.prepare(query)
                    .bind(...(params || []))
                    .all();

                return c.json(results);
            } catch (error: any) {
                return c.json({ error: error.message }, 500);
            }
        });

        // Root endpoint - API bilgisi
        app.get('/', async (c) => {
            return c.json({
                name: 'd1-secret-rest',
                version: '2.0.0',
                endpoints: {
                    list_databases: 'GET /databases',
                    rest_api: '/db/{dbName}/rest/{table}',
                    raw_query: 'POST /db/{dbName}/query'
                }
            });
        });

        return app.fetch(request, env, ctx);
    }
} satisfies ExportedHandler<Env>;
