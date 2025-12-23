#!/usr/bin/env node

import fs from "fs";
import path from "path";
import yaml from "js-yaml";

console.log("📝 Starting documentation generation...");

// Ensure output directory exists
const outputDir = path.join(__dirname, "public", "docs");
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
  console.log(`📁 Created output directory: ${outputDir}`);
}

// Check if auth directory exists
const authDir = path.join(__dirname, "auth");
if (!fs.existsSync(authDir)) {
  console.error(`❌ Auth directory not found: ${authDir}`);
  console.log("📁 Creating auth directory structure...");

  // Create basic directory structure
  fs.mkdirSync(authDir, { recursive: true });
  fs.mkdirSync(path.join(authDir, "paths"), { recursive: true });
  fs.mkdirSync(path.join(authDir, "schemas"), { recursive: true });
  fs.mkdirSync(path.join(authDir, "examples"), { recursive: true });
  fs.mkdirSync(path.join(__dirname, "templates"), { recursive: true });

  // Create basic swaggerAuth.yaml
  const basicSpec = {
    openapi: "3.0.0",
    info: {
      title: "Auth API Documentation",
      version: "1.0.0",
      description:
        "Authentication API for user registration, login, and account management",
    },
    servers: [
      {
        url: "http://localhost:3000/api/v1",
        description: "Local Development Server",
      },
    ],
    paths: {
      "/auth/register": {
        post: {
          summary: "Register a new user",
          description: "Create a new user account with email and password",
          tags: ["Authentication"],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["email", "password"],
                  properties: {
                    email: {
                      type: "string",
                      format: "email",
                      example: "user@example.com",
                    },
                    password: {
                      type: "string",
                      format: "password",
                      example: "SecurePass123!",
                    },
                  },
                },
              },
            },
          },
          responses: {
            "201": {
              description: "User registered successfully",
            },
          },
        },
      },
    },
  };

  fs.writeFileSync(
    path.join(authDir, "swaggerAuth.yaml"),
    yaml.dump(basicSpec)
  );
  console.log(`✅ Created basic swaggerAuth.yaml in ${authDir}`);
}

try {
  // Load main spec
  const mainSpecPath = path.join(authDir, "swaggerAuth.yaml");
  console.log(`📄 Loading spec from: ${mainSpecPath}`);

  if (!fs.existsSync(mainSpecPath)) {
    throw new Error(`Main spec file not found: ${mainSpecPath}`);
  }

  const content = fs.readFileSync(mainSpecPath, "utf8");
  const spec = yaml.load(content);

  // Save as JSON
  const jsonPath = path.join(outputDir, "auth-api-spec.json");
  fs.writeFileSync(jsonPath, JSON.stringify(spec, null, 2));
  console.log(`✅ Generated JSON spec: ${jsonPath}`);

  // Save as YAML
  const yamlPath = path.join(outputDir, "auth-api-spec.yaml");
  fs.writeFileSync(yamlPath, yaml.dump(spec));
  console.log(`✅ Generated YAML spec: ${yamlPath}`);

  // Create basic HTML
  const htmlTemplate = `<!DOCTYPE html>
<html>
<head>
    <title>Auth API Documentation</title>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <link href="https://fonts.googleapis.com/css?family=Montserrat:300,400,700|Roboto:300,400,700" rel="stylesheet">
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@4/swagger-ui.css">
    <style>
        body { margin: 0; padding: 0; }
        #swagger-ui { padding: 20px; }
    </style>
</head>
<body>
    <div id="swagger-ui"></div>
    <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@4/swagger-ui-bundle.js"></script>
    <script>
        window.onload = function() {
            window.ui = SwaggerUIBundle({
                url: "./auth-api-spec.json",
                dom_id: '#swagger-ui',
                presets: [
                    SwaggerUIBundle.presets.apis,
                    SwaggerUIStandalonePreset
                ],
                layout: "StandaloneLayout"
            });
        }
    </script>
</body>
</html>`;

  const htmlPath = path.join(outputDir, "index.html");
  fs.writeFileSync(htmlPath, htmlTemplate);
  console.log(`✅ Generated HTML docs: ${htmlPath}`);

  // Create GitHub Pages version
  const ghPagesHtml = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Auth API Documentation</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
            line-height: 1.6;
            max-width: 1200px;
            margin: 0 auto;
            padding: 20px;
            background: #f5f5f5;
        }
        .container {
            background: white;
            border-radius: 10px;
            padding: 30px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
        }
        header {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 40px;
            border-radius: 10px;
            margin-bottom: 30px;
            text-align: center;
        }
        h1 {
            margin: 0;
            font-size: 2.5rem;
        }
        .endpoint {
            border: 1px solid #e1e4e8;
            border-radius: 6px;
            padding: 20px;
            margin: 20px 0;
            background: white;
        }
        .method {
            display: inline-block;
            padding: 5px 12px;
            border-radius: 4px;
            color: white;
            font-weight: bold;
            margin-right: 10px;
            font-size: 0.9rem;
        }
        .post { background: #49cc90; }
        .get { background: #61affe; }
        .endpoint-path {
            font-family: monospace;
            font-size: 1.1rem;
            font-weight: 600;
        }
        code {
            background: #f6f8fa;
            padding: 2px 6px;
            border-radius: 3px;
            font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
        }
        pre {
            background: #f6f8fa;
            padding: 15px;
            border-radius: 5px;
            overflow-x: auto;
        }
    </style>
</head>
<body>
    <div class="container">
        <header>
            <h1>🔐 Auth API Documentation</h1>
            <p>Complete authentication API for user management</p>
        </header>
        
        <h2>📋 Quick Start</h2>
        <p>Base URL: <code>http://localhost:3000/api/v1</code></p>
        
        <h2>🔌 Endpoints</h2>
        
        <div class="endpoint">
            <span class="method post">POST</span>
            <span class="endpoint-path">/auth/register</span>
            <h3>Register a new user</h3>
            <p>Create a new user account with email and password</p>
            
            <h4>Example Request</h4>
            <pre><code>{
  "email": "user@example.com",
  "password": "SecurePass123!"
}</code></pre>
            
            <h4>Example Response</h4>
            <pre><code>{
  "success": true,
  "data": {
    "user": {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "email": "user@example.com"
    },
    "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
  }
}</code></pre>
        </div>
        
        <div class="endpoint">
            <span class="method post">POST</span>
            <span class="endpoint-path">/auth/login</span>
            <h3>Login with email/password</h3>
            <p>Authenticate user and receive access tokens</p>
        </div>
        
        <div class="endpoint">
            <span class="method get">GET</span>
            <span class="endpoint-path">/auth/me</span>
            <h3>Get current user</h3>
            <p>Get authenticated user information</p>
            <p><strong>Authentication required:</strong> Bearer token</p>
        </div>
        
        <h2>🔑 Authentication</h2>
        <p>Use JWT tokens for authentication:</p>
        <pre><code>Authorization: Bearer &lt;your-access-token&gt;</code></pre>
        
        <h2>🚀 Try it out</h2>
        <p>For interactive testing, open the <a href="./index.html">Swagger UI</a>.</p>
    </div>
</body>
</html>`;

  const ghPagesPath = path.join(outputDir, "github-pages.html");
  fs.writeFileSync(ghPagesPath, ghPagesHtml);
  console.log(`✅ Generated GitHub Pages: ${ghPagesPath}`);

  console.log("\n🎉 Documentation generation completed!");
  console.log(`📁 Files saved in: ${outputDir}`);
  console.log("\n📋 Available files:");
  console.log(`  - ${path.relative(process.cwd(), jsonPath)}`);
  console.log(`  - ${path.relative(process.cwd(), yamlPath)}`);
  console.log(`  - ${path.relative(process.cwd(), htmlPath)}`);
  console.log(`  - ${path.relative(process.cwd(), ghPagesPath)}`);
} catch (error) {
  console.error("❌ Error generating documentation:", error);
  process.exit(1);
}
