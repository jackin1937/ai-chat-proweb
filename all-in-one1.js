import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';
import { promisify } from 'util';
import os from 'os';
import zlib from 'zlib';
import authServer from './auth-server.js';
const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

try {
    const envFile = path.join(__dirname, '.env');
    if (fs.existsSync(envFile)) {
        for (const rawLine of fs.readFileSync(envFile, 'utf-8').split(/\r?\n/)) {
            const line = rawLine.trim();
            if (!line || line.startsWith('#')) continue;
            const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
            if (!match) continue;
            let value = match[2].trim();
            if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value[value.length - 1] === value[0]) {
                value = value.slice(1, -1);
            }
            if (process.env[match[1]] === undefined) process.env[match[1]] = value;
        }
    }
} catch (envError) {
    console.error('[ENV] Could not read .env:', envError.message);
}
// ─── TTL Cache (prevents memory leak in SerpAPI tokens) ──────────
class TTLCache extends Map {
    constructor(ttlMs = 3600000, maxEntries = 500) {
        super();
        this._ttl = ttlMs;
        this._max = maxEntries;
    }
    set(key, value) {
        if (this.size >= this._max) {
            const oldest = this.keys().next().value;
            this.delete(oldest);
        }
        return super.set(key, { value, ts: Date.now() });
    }
    get(key) {
        const entry = super.get(key);
        if (!entry) return undefined;
        if (Date.now() - entry.ts > this._ttl) {
            this.delete(key);
            return undefined;
        }
        return entry.value;
    }
}

if (!global.serpapiTokens) global.serpapiTokens = new TTLCache(3600000, 200);
if (!global.serpapiQueries) global.serpapiQueries = new TTLCache(3600000, 200);

// API Configuration
const API_KEYS = [
    // GNews - Technology & General News
    {
        key: process.env.GNEWS_KEY,
        endpoint: "https://gnews.io/api/v4",
        model: "gnews",
        name: "GNews Technology",
        provider: "gnews"
    },
    // In API_KEYS array, add these entries:
    {
        key: process.env.SAMBANOVA_KEY,
        endpoint: "https://api.sambanova.ai/v1/chat/completions",
        model: "DeepSeek-V3.2",
        name: "DeepSeek-V3.2 (671B)",
        provider: "sambanova-deepseek"       // ← matches client's 'sambanova-deepseek'
    },
    // If you have a separate SambaNova GPT-OSS key, add it:
    {
        key: process.env.SAMBANOVA_GPTOSS_KEY || process.env.SAMBANOVA_KEY,
        endpoint: "https://api.sambanova.ai/v1/chat/completions",
        model: "gpt-oss-120b",          // or whatever the actual model ID is
        name: "GPT-OSS 120B",
        provider: "sambanova-gptoss"    // ← matches client
    },
    // ChatAnywhere – GPT-4o-mini (Key 1)
    {
        key: process.env.CHATANYWHERE_KEY_1,
        endpoint: "https://api.chatanywhere.tech/v1/chat/completions",
        model: "gpt-4o-mini",
        name: "GPT-4o Mini (CA-1)",
        provider: "chatanywhere"
    },
    // ChatAnywhere – GPT-4o-mini (Key 2 — falls back to Key 1 if not set)
    {
        key: process.env.CHATANYWHERE_KEY_2 || process.env.CHATANYWHERE_KEY_1,
        endpoint: "https://api.chatanywhere.tech/v1/chat/completions",
        model: "gpt-4o-mini",
        name: "GPT-4o Mini (CA-2)",
        provider: "chatanywhere1"
    },
    // OpenRouter – DeepSeek V3
    {
        key: process.env.OPENROUTER_KEY,
        endpoint: "https://openrouter.ai/api/v1/chat/completions",
        model: "deepseek/deepseek-chat",
        name: "DeepSeek V3 (OpenRouter)",
        provider: "openrouter-deepseek"
    },
    // OpenRouter – DeepSeek R1
    {
        key: process.env.OPENROUTER_KEY,
        endpoint: "https://openrouter.ai/api/v1/chat/completions",
        model: "deepseek/deepseek-r1",
        name: "DeepSeek R1 (OpenRouter)",
        provider: "openrouter-r1"
    },
    // Pawan.krd GPT-OSS
    {
        key: process.env.PAWAN_KEY,
        endpoint: "https://api.pawan.krd/v1/chat/completions",
        model: "openai/gpt-oss-20b",
        name: "GPT-OSS 20B",
        provider: "pawan"
    },
    // SerpAPI - Google AI Mode
    {
        key: process.env.SERPAPI_KEY,
        endpoint: "https://serpapi.com/search",
        model: "google_ai_mode",
        name: "Google AI Mode Search",
        provider: "serpapi"
    },
    // Google Custom Search - DeepGoogling
    {
        key: process.env.GOOGLE_CSE_KEY,
        endpoint: "https://customsearch.googleapis.com/customsearch/v1",
        model: "custom_search",
        name: "DeepGoogling",
        provider: "google_cse",
        cx: process.env.GOOGLE_CSE_CX
    },
    // Google Jobs Search via SerpAPI
    {
        key: process.env.SERPAPI_KEY,
        endpoint: "https://serpapi.com/search",
        model: "google_jobs",
        name: "Google Jobs Search",
        provider: "serpapi_jobs"
    },
    {
        key: 'puter-client-side',
        endpoint: 'https://api.puter.com',
        model: 'gemini-2.5-flash-lite',
        name: 'Gemini 2.5 Flash Lite',
        provider: 'puter-gemini'
    },
    {
        key: 'puter-client-side',
        endpoint: 'https://api.puter.com',
        model: 'gpt-5.4-nano',
        name: 'GPT-5.4 Nano',
        provider: 'puter-gpt-nano'
    },
    {
        key: process.env.KIMI_KEY,
        endpoint: 'https://api.moonshot.cn/v1/chat/completions',
        model: 'moonshot-v1-8k',
        name: 'Kimi (Moonshot 8K)',
        provider: 'kimi'
    },
    {
        key: process.env.KIMI_KEY,
        endpoint: 'https://api.moonshot.cn/v1/chat/completions',
        model: 'moonshot-v1-32k',
        name: 'Kimi (Moonshot 32K)',
        provider: 'kimi-32k'
    },
    {
        key: process.env.KIMI_KEY,
        endpoint: 'https://api.moonshot.cn/v1/chat/completions',
        model: 'moonshot-v1-128k',
        name: 'Kimi (Moonshot 128K — Long Context)',
        provider: 'kimi-128k'
    },
    {
        key: process.env.KIMI_KEY,
        endpoint: 'https://api.moonshot.cn/v1/chat/completions',
        model: 'moonshot-v1-8k',
        name: 'Kimi Web Search',
        provider: 'kimi-search'
    },
    {
        key: process.env.GPT_NANO,
        endpoint: 'https://nano-gpt.com/api/v1/chat/completions',
        model: 'gpt-5.2',
        name: 'GPT NANO',
        provider: 'GPT-Nano'
    },
    // Linkup - Deep web search with sourced answers
    {
        key: process.env.LINKUP_API_KEY,
        endpoint: "https://api.linkup.so/v1/search",
        model: "linkup",
        name: "Linkup Deep Search",
        provider: "linkup"
    },
    // Blackbox AI - Free tier
    {
        key: 'blackbox-free',  // Dummy key, actual auth is via sessionId
        endpoint: "https://app.blackbox.ai/api/chat",
        model: "blackbox",
        name: "Blackbox AI (Free)",
        provider: "blackbox",
        sessionId: process.env.BLACKBOX_SESSION_ID || "cadd7e68-3dd2-41c5-b8bc-c3435fc2a3c1",
        userId: process.env.BLACKBOX_USER_ID || null,
        validated: process.env.BLACKBOX_VALIDATED || "a38f5889-8fef-46d4-8ede-bf4668b6a9bb"
    },
    {
        key: process.env.OLLAMA_API_KEY,
        endpoint: "https://ollama.com/v1/chat/completions",
        model: "gemma4:31b",
        name: "Gemma 4 31B (Ollama Cloud)",
        provider: "ollama"
    }
    
].filter(entry => entry.key); // Remove any entries where key is undefined

// ─── GitHub AI (DeepSeek-V3-0324) — fast, free tier ───────────
const GITHUB_AI_KEYS = [
    process.env.GITHUB_AI_KEY_1,
    process.env.GITHUB_AI_KEY_2
].filter(Boolean);
let _ghKeyIdx = 0;


// ─── Kimi AI with optional web search ────────────────────────
async function callKimiWithSearch(keyObj, messages, maxTokens = 4096) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45000);

    // Build request body with web_search tool enabled
    const body = JSON.stringify({
        model: 'moonshot-v1-8k',
        messages: messages,
        max_tokens: maxTokens,
        temperature: 0.7,
        tools: [
            {
                type: 'builtin_function',
                function: { name: '$web_search' }
            }
        ]
    });

    try {
        const res = await fetch('https://api.moonshot.cn/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${keyObj.key}`,
                'User-Agent': 'AI-Assistant/1.0'
            },
            body,
            signal: controller.signal
        });
        clearTimeout(timeout);

        if (!res.ok) {
            const errText = await res.text();
            throw new Error(`Kimi API ${res.status}: ${errText.substring(0, 150)}`);
        }

        const data = await res.json();

        // Handle tool_calls: if Kimi called $web_search, run another turn
        const choice = data.choices?.[0];
        if (choice?.finish_reason === 'tool_calls' && choice?.message?.tool_calls?.length > 0) {
            console.log('[Kimi] Web search triggered, running tool call loop...');

            const toolMessages = [
                ...messages,
                { role: 'assistant', content: choice.message.content || '', tool_calls: choice.message.tool_calls }
            ];

            // Add tool results (Kimi handles the actual search server-side;
            // we just need to send back a tool result message)
            for (const toolCall of choice.message.tool_calls) {
                toolMessages.push({
                    role: 'tool',
                    tool_call_id: toolCall.id,
                    name: toolCall.function.name,
                    content: ''   // Kimi's builtin search fills this itself
                });
            }

            // Second call to get the final answer
            const body2 = JSON.stringify({
                model: 'moonshot-v1-8k',
                messages: toolMessages,
                max_tokens: maxTokens,
                temperature: 0.7,
                tools: [{ type: 'builtin_function', function: { name: '$web_search' } }]
            });

            const res2 = await fetch('https://api.moonshot.cn/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${keyObj.key}`
                },
                body: body2
            });

            if (!res2.ok) {
                const errText2 = await res2.text();
                throw new Error(`Kimi tool loop ${res2.status}: ${errText2.substring(0, 150)}`);
            }

            return await res2.json();
        }

        return data;

    } catch (e) {
        clearTimeout(timeout);
        if (e.name === 'AbortError') throw new Error('Kimi request timed out');
        throw e;
    }
}

async function callGitHubAI(prompt, maxTokens = 700) {
    if (GITHUB_AI_KEYS.length === 0) {
        throw new Error('No GitHub AI keys configured (GITHUB_AI_KEY_1 / GITHUB_AI_KEY_2 missing from .env)');
    }
    const key = GITHUB_AI_KEYS[_ghKeyIdx % GITHUB_AI_KEYS.length];
    _ghKeyIdx++;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
        const res = await fetch('https://models.github.ai/inference/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${key}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: 'deepseek/DeepSeek-V3-0324',
                messages: [{ role: 'user', content: prompt }],
                max_tokens: maxTokens
            }),
            signal: controller.signal
        });
        clearTimeout(timeout);
        if (!res.ok) throw new Error(`GitHub AI ${res.status}`);
        const data = await res.json();
        return data.choices?.[0]?.message?.content || '';
    } catch (e) {
        clearTimeout(timeout);
        throw e;
    }
}

async function callPuterAI(keyObj) {
    return {
        choices: [{
            message: {
                content: '__PUTER_CLIENT_SIDE__',
                provider: keyObj.name,
                puterModel: keyObj.model
            },
            finish_reason: 'puter_client'
        }]
    };
}

async function callGoogleJobs(keyObj, messages, maxTokens = 4096) {
    const lastMessage = messages[messages.length - 1];
    let query = lastMessage.content;
    
    // Parse job search parameters
    let jobTitle = query;
    let location = "";
    
    // Check for location pattern (e.g., "barista in Austin, TX")
    const locationMatch = query.match(/(.+)\s+(?:in|at|near)\s+(.+)/i);
    if (locationMatch) {
        jobTitle = locationMatch[1].trim();
        location = locationMatch[2].trim();
    }
    
    // Build search parameters
    const params = new URLSearchParams({
        engine: "google_jobs",
        q: jobTitle,
        api_key: keyObj.key,
        google_domain: "google.com",
        hl: "en",
        gl: "us"
    });
    
    if (location) {
        params.append("location", location);
    }
    
    const url = `${keyObj.endpoint}?${params.toString()}`;
    
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    
    try {
        console.log(`[Jobs API] Searching: "${jobTitle}" in "${location || 'any location'}"`);
        
        const res = await fetch(url.toString(), {
            method: "GET",
            headers: { "User-Agent": "AI-Assistant/1.0" },
            signal: controller.signal
        });
        
        clearTimeout(timeout);
        
        if (!res.ok) {
            const errorData = await res.text();
            console.error(`[Jobs API] Error: ${errorData}`);
            throw new Error(`Jobs API Error ${res.status}`);
        }
        
        const data = await res.json();
        
        // Debug logging
        if (data.jobs_results) {
            console.log(`[Jobs API] Found ${data.jobs_results.length} jobs`);
        } else if (data.error) {
            console.error(`[Jobs API] API Error: ${data.error.message}`);
        }
        
        // Format job results
        let formattedResponse = formatJobsResponse(data, jobTitle, location);
        
        return {
            choices: [{
                message: {
                    content: formattedResponse,
                    provider: "Google Jobs",
                    raw_data: data,
                    jobCount: data.jobs_results?.length || 0
                },
                finish_reason: "stop"
            }]
        };
        
    } catch (error) {
        clearTimeout(timeout);
        console.error(`[Jobs API] Error:`, error);
        throw error;
    }
}



function formatJobsResponse(data, jobTitle, location) {
    const locationText = location ? `in ${location}` : "";
    let output = `# 💼 Job Search Results: ${jobTitle} ${locationText}\n\n`;
    
    if (data.search_metadata) {
        output += `**Search Time**: ${data.search_metadata.total_time_taken} seconds\n`;
        output += `**Page**: ${data.search_metadata.page || 1}\n\n`;
    }
    
    if (data.jobs_results && data.jobs_results.length > 0) {
        output += `## 📊 Found ${data.jobs_results.length} Job Postings\n\n`;
        
        data.jobs_results.forEach((job, idx) => {
            output += `### ${idx + 1}. ${job.title || 'Position Available'}\n`;
            output += `- **Company**: ${job.company_name || 'Not specified'}\n`;
            
            // FIX: Handle location properly (could be string or array)
            if (job.location) {
                if (Array.isArray(job.location)) {
                    output += `- **Location**: ${job.location.map(l => l.name || l).join(', ')}\n`;
                } else if (typeof job.location === 'string') {
                    output += `- **Location**: ${job.location}\n`;
                } else if (job.location.name) {
                    output += `- **Location**: ${job.location.name}\n`;
                }
            }
            
            // Handle extensions safely
            if (job.detected_extensions) {
                if (job.detected_extensions.schedule) {
                    output += `- **Schedule**: ${job.detected_extensions.schedule}\n`;
                }
                if (job.detected_extensions.applications) {
                    output += `- **Applications**: ${job.detected_extensions.applications}\n`;
                }
                if (job.detected_extensions.posted_by) {
                    output += `- **Posted By**: ${job.detected_extensions.posted_by}\n`;
                }
            }
            
            // Handle links
            if (job.related_links && job.related_links.length > 0) {
                output += `- **Apply**: [View Job](${job.related_links[0].link})\n`;
            } else if (job.apply_link) {
                output += `- **Apply**: [View Job](${job.apply_link})\n`;
            }
            
            // Handle description safely
            if (job.description) {
                const shortDesc = job.description.substring(0, 250);
                output += `- **Description**: ${shortDesc}${job.description.length > 250 ? '...' : ''}\n`;
            }
            
            // Handle salary if available
            if (job.salary) {
                output += `- **Salary**: ${job.salary}\n`;
            }
            
            output += `\n`;
        });
    } else if (data.error) {
        output += `## ❌ API Error\n\n`;
        output += `**Error**: ${data.error.message || 'Unknown error'}\n`;
        output += `**Code**: ${data.error.code || 'N/A'}\n\n`;
    } else {
        output += `## ❌ No jobs found\n\n`;
        output += `Try:\n`;
        output += `- Different job title (e.g., "developer", "engineer")\n`;
        output += `- Adding location (e.g., "barista in Austin")\n`;
        output += `- Removing location for remote/anywhere jobs\n`;
        output += `- Using fewer words (e.g., "python developer")\n`;
    }
    
    // Job search tips
    output += `---\n`;
    output += `### 💡 Job Search Tips:\n`;
    output += `- Use format: \`"job title in location"\` (e.g., "software engineer in San Francisco")\n`;
    output += `- Try: \`"remote python developer"\` for remote jobs\n`;
    output += `- Add filters: \`"entry level data scientist"\` for experience level\n`;
    output += `- For exact title: use quotes \`"registered nurse"\`\n`;
    
    return output;
}
// Replace your existing callSerpAPIMultiPage function with this:

async function callSerpAPIMultiPage(keyObj, messages, maxTokens = 4096) {
    const lastMessage = messages[messages.length - 1];
    let query = lastMessage.content;
    
    let pageMatch = query.match(/page:(\d+)/i);
    let currentPage = pageMatch ? parseInt(pageMatch[1]) : 1;
    let cleanQuery = query.replace(/\s*page:\d+\s*/i, '').trim();
    
    const params = new URLSearchParams({ engine: "google_ai_mode", q: cleanQuery, api_key: keyObj.key, num: 20 });
    const tokenKey = cleanQuery.toLowerCase();
    
    if (currentPage > 1) {
        const storedToken = global.serpapiTokens.get(tokenKey); // FIX: Use TTLCache .get()
        if (storedToken) { params.append("next_page_token", storedToken); }
        else {
            const page1Params = new URLSearchParams({ engine: "google_ai_mode", q: cleanQuery, api_key: keyObj.key, num: 20 });
            const page1Res = await fetch(`${keyObj.endpoint}?${page1Params.toString()}`, { headers: { "User-Agent": "AI-Assistant/1.0" } });
            const page1Data = await page1Res.json();
            if (page1Data.next_page_token) { global.serpapiTokens.set(tokenKey, page1Data.next_page_token); params.append("next_page_token", page1Data.next_page_token); }
        }
    }
    
    const url = `${keyObj.endpoint}?${params.toString()}`;
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 30000);
    
    try {
        const serpRes = await fetch(url, { method: "GET", headers: { "User-Agent": "AI-Assistant/1.0" }, signal: controller.signal });
        clearTimeout(timeout); if (!serpRes.ok) throw new Error(`SerpAPI Error ${serpRes.status}`);
        const data = await serpRes.json();
        if (data.next_page_token) { global.serpapiTokens.set(tokenKey, data.next_page_token); } // FIX: Use TTLCache .set()
        global.serpapiQueries.set(tokenKey, cleanQuery);
        return { choices: [{ message: { content: formatSerpResponse(data, cleanQuery, currentPage), provider: keyObj.name, currentPage, hasNextPage: !!data.next_page_token }, finish_reason: "stop" }] };
    } catch (error) { clearTimeout(timeout); throw error; }
}
// Add function to analyze all pages
async function analyzeAllPages(keyObj, query, maxPages = 5) {
    console.log(`[SerpAPI] Analyzing all pages for: "${query}"`);
    let allResults = []; let currentPage = 1; let hasNextPage = true; let nextPageToken = null;
    
    while (hasNextPage && currentPage <= maxPages) {
        const params = new URLSearchParams({ engine: "google_ai_mode", q: query, api_key: keyObj.key, num: 20 });
        if (nextPageToken) { params.append("next_page_token", nextPageToken); console.log(`[SerpAPI] Using token for page ${currentPage}`); }
        
        try {
            const res = await fetch(`${keyObj.endpoint}?${params.toString()}`, { method: "GET", headers: { "User-Agent": "AI-Assistant/1.0" } });
            if (!res.ok) break;
            const data = await res.json();
            if (!data.shopping_results?.length && !data.organic_results?.length && currentPage > 1) break;
            allResults.push(data);
            nextPageToken = data.next_page_token || null;
            hasNextPage = !!nextPageToken;
            
            // Store token in TTLCache
            if (hasNextPage) { global.serpapiTokens.set(query.toLowerCase(), nextPageToken); currentPage++; await new Promise(r => setTimeout(r, 1000)); }
            else break;
        } catch (error) { console.error(`[SerpAPI] Error fetching page ${currentPage}:`, error.message); break; }
    }
    return { results: allResults, totalPages: allResults.length };
}
// Add this to your server's route handling (after the existing /api endpoint)

// Add the SerpAPI handler function
async function callSerpAPI(keyObj, messages, maxTokens = 4096) {
    const lastMessage = messages[messages.length - 1];
    const query = lastMessage.content;
    
    const params = new URLSearchParams({
        engine: "google_ai_mode",
        q: query,
        api_key: keyObj.key
    });
    
    const url = `${keyObj.endpoint}?${params.toString()}`;
    
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    
    try {
        console.log(`[SerpAPI] Searching: "${query}"`);
        
        const res = await fetch(url, {
            method: "GET",
            headers: {
                "User-Agent": "AI-Assistant/1.0"
            },
            signal: controller.signal
        });
        
        clearTimeout(timeout);
        
        if (!res.ok) {
            throw new Error(`SerpAPI Error ${res.status}`);
        }
        
        const data = await res.json();
        
        // Format the response as a readable message
        let formattedResponse = formatSerpResponse(data, query);
        
        return {
            choices: [{
                message: {
                    content: formattedResponse,
                    provider: keyObj.name,
                    raw_data: data
                },
                finish_reason: "stop"
            }]
        };
        
    } catch (error) {
        clearTimeout(timeout);
        throw error;
    }
}

// ─── Linkup Deep Search Handler ────────────────────────
async function callLinkup(keyObj, messages, maxTokens = 4096) {
    const lastMessage = messages[messages.length - 1];
    const query = lastMessage.content;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45000);

    try {
        console.log(`[Linkup] Searching: "${query}"`);

        // Linkup /search requires POST with body parameters
        const res = await fetch(keyObj.endpoint, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${keyObj.key}`,
                "Content-Type": "application/json",
                "User-Agent": "AI-Assistant/1.0"
            },
            body: JSON.stringify({
                q: query,
                depth: "standard",
                outputType: "sourcedAnswer",
                includeImages: false
            }),
            signal: controller.signal
        });

        clearTimeout(timeout);

        if (!res.ok) {
            const errText = await res.text();
            throw new Error(`Linkup Error ${res.status}: ${errText.substring(0, 200)}`);
        }

        const data = await res.json();

        let output = `# 🔍 Linkup Search: "${query}"\n\n`;

        if (data.answer) {
            output += `## 💡 Answer\n\n${data.answer}\n\n`;
        }

        if (data.sources && data.sources.length > 0) {
            output += `## 📚 Sources (${data.sources.length})\n\n`;
            data.sources.forEach((src, i) => {
                output += `${i + 1}. **[${src.name || src.title || 'Source'}](${src.url})**\n`;
                if (src.snippet) {
                    output += `   > ${src.snippet.substring(0, 250)}...\n`;
                }
                output += `\n`;
            });
        }

        return {
            choices: [{
                message: {
                    content: output,
                    provider: "Linkup",
                    raw: data
                },
                finish_reason: "stop"
            }]
        };

    } catch (error) {
        clearTimeout(timeout);
        console.error(`[Linkup] Error:`, error.message);
        throw error;
    }
}

// ─── Unified SerpAPI Response Formatter ──────────────────
function formatSerpResponse(data, query, page = 1) {
    let output = `# 🔍 Google AI Mode Results for: "${query}"\n`;
    
    if (page > 1 || data.next_page_token) {
        output += `## 📄 Page ${page} of Results\n\n`;
        output += `### 📑 Page Navigation\n`;
        output += `- **Current Page**: ${page}\n`;
        if (data.next_page_token) {
            output += `- **Next Page**: Type "${query} page:${page + 1}" to see more results\n`;
        }
        if (page > 1) {
            output += `- **Previous Page**: Type "${query} page:${page - 1}" for previous results\n`;
        }
        output += `- **Analyze All**: Type "analyze all pages for ${query}" for complete analysis\n\n`;
    }
    
    // AI-generated summary
    if (data.reconstructed_markdown) {
        output += "## 🤖 AI-Generated Summary\n\n";
        output += data.reconstructed_markdown + "\n\n";
    }
    
    // Shopping results
    if (data.shopping_results?.length > 0) {
        output += `## 🛒 Shopping Results${page > 1 ? ` (Page ${page})` : ''}\n\n`;
        const offset = (page - 1) * 20;
        data.shopping_results.forEach((item, idx) => {
            output += `### ${offset + idx + 1}. ${item.title}\n`;
            output += `- **Price**: ${item.price}\n`;
            if (item.rating) output += `- **Rating**: ${item.rating}⭐ (${item.reviews || 0} reviews)\n`;
            if (item.source) output += `- **Source**: ${item.source}\n`;
            if (item.product_link) output += `- [View Product](${item.product_link})\n`;
            output += `\n`;
        });
    }
    
    // Organic results
    if (data.organic_results?.length > 0) {
        output += `## 🌐 Web Results${page > 1 ? ` (Page ${page})` : ''}\n\n`;
        const offset = (page - 1) * 20;
        data.organic_results.forEach((item, idx) => {
            output += `### ${offset + idx + 1}. ${item.title}\n`;
            output += `- **Link**: ${item.link}\n`;
            if (item.snippet) output += `- **Snippet**: ${item.snippet}\n`;
            output += `\n`;
        });
    }
    
    // Text blocks
    if (data.text_blocks) {
        output += "## 📝 AI Analysis\n\n";
        data.text_blocks.forEach(block => {
            if (block.type === "paragraph") output += `${block.snippet}\n\n`;
            else if (block.type === "heading") output += `### ${block.snippet}\n\n`;
            else if (block.type === "list" && block.list) {
                block.list.forEach(item => { if (item.snippet) output += `- ${item.snippet}\n`; });
                output += "\n";
            } else if (block.type === "table" && block.formatted) {
                block.formatted.forEach(row => {
                    output += `- ${Object.entries(row).map(([k,v]) => `${k}: ${v}`).join(' | ')}\n`;
                });
                output += "\n";
            }
        });
    }
    
    // Related questions
    if (data.related_questions?.length > 0) {
        output += "## ❓ Related Questions\n\n";
        data.related_questions.forEach((q, idx) => { output += `${idx + 1}. ${q.question}\n`; });
        output += "\n";
    }
    
    // Knowledge graph
    if (data.knowledge_graph) {
        output += "## 📊 Knowledge Graph\n\n";
        if (data.knowledge_graph.title) output += `**${data.knowledge_graph.title}**\n`;
        if (data.knowledge_graph.description) output += `${data.knowledge_graph.description}\n\n`;
    }
    
    // Sources/References
    if (data.references?.length > 0) {
        output += "## 📚 Sources & References\n\n";
        data.references.forEach((ref, idx) => {
            output += `${idx + 1}. **[${ref.title}](${ref.link})** - ${ref.source}\n`;
            if (ref.snippet) output += `   > ${ref.snippet.substring(0, 200)}...\n`;
            output += `\n`;
        });
    }
    
    // Pagination tips
    output += "---\n";
    output += "### 💡 Tips for better results:\n";
    output += "- Add `page:2`, `page:3` etc. to see more results\n";
    output += "- Type `analyze all pages for [query]` for comprehensive analysis\n";
    
    return output;
}

class KeyPool {
    constructor(keys) {
        this.keys = keys.map((k, i) => ({
            key: k.key, 
            endpoint: k.endpoint, 
            model: k.model,
            name: k.name,
            provider: k.provider,
            cx: k.cx || null,
            index: i, 
            inUse: false, 
            requests: 0, 
            errors: 0, 
            lastUsed: 0, 
            cooldown: 0,
            lastError: null, 
            lastErrorTime: null
        }));
    }
    
    getKey(provider = null) {
            const now = Date.now();
            let available = this.keys.filter(k => !k.inUse && (now - k.cooldown > 3000));
            
            const SEARCH_PROVIDERS = ['serpapi', 'google_cse', 'serpapi_jobs', 'gnews', 'puter-gemini', 'puter-gpt-nano','linkup'];
            
            if (provider && provider !== 'auto') {
                available = available.filter(k => k.provider === provider);
            } else {
                available = available.filter(k => !SEARCH_PROVIDERS.includes(k.provider));
                available.sort((a, b) => {
                    const priority = ['blackbox', 'chatanywhere', 'chatanywhere1', 'GPT-Nano', 'kimi', 'sambanova-deepseek', 'sambanova-gptoss', 'pawan', 'ollama'];
                    const pa = priority.indexOf(a.provider);
                    const pb = priority.indexOf(b.provider);
                    if (pa === -1 && pb === -1) return a.requests - b.requests;
                    if (pa === -1) return 1;
                    if (pb === -1) return -1;
                    return pa - pb;
                });
            }
        
        if (available.length === 0) return null;
        
        // Sort by requests (least used first)
        available.sort((a, b) => a.requests - b.requests);
        const selected = available[0];
        selected.inUse = true; 
        selected.lastUsed = now; 
        selected.requests++;
        return selected;
    }
    
    releaseKey(k, err = null) {
        k.inUse = false;
        if (err) {
            k.errors++;
            // 429 rate limit: cool down 30s; others: 3s
            const isRateLimit = err.message?.includes('429');
            const is504       = err.message?.includes('504');
            const is400       = err.message?.includes('400') || err.message?.includes('invalid');
            // 400 = bad request (our fault), don't penalize the key
            k.cooldown = isRateLimit ? Date.now() + 27000
                       : is504       ? Date.now() + 60000
                       : is400       ? Date.now()           // no cooldown
                       :               Date.now() + 2000;   // generic: 2s soft cooldown
            k.lastError = err.message || String(err);
            k.lastErrorTime = new Date().toISOString();
        }
    }
    
    getStats() {
        return this.keys.map(k => ({
            name: k.name,
            provider: k.provider,
            key: String(k.key).slice(0, 10) + '...',
            endpoint: new URL(k.endpoint).hostname,
            requests: k.requests,
            errors: k.errors,
            inUse: k.inUse,
            cooldown: Math.max(0, Math.ceil((k.cooldown + 3000 - Date.now()) / 1000)),
            lastError: k.lastError,
            lastErrorTime: k.lastErrorTime
        }));
    }
}

// Google CSE Handler Function
async function callGoogleCSE(keyObj, messages, maxTokens = 4096) {
    const lastMessage = messages[messages.length - 1];
    let query = lastMessage.content;
    
    // Extract page parameter
    let pageMatch = query.match(/page:(\d+)/i);
    let currentPage = pageMatch ? parseInt(pageMatch[1]) : 1;
    let cleanQuery = query.replace(/\s*page:\d+\s*/i, '').trim();
    
    // Remove "analyze all pages" if present
    if (cleanQuery.toLowerCase().includes('analyze all pages for')) {
        cleanQuery = cleanQuery.replace(/analyze all pages for/i, '').trim();
    }
    
    // Google CSE uses 'start' parameter for pagination (0-indexed, 10 results per page)
    const startIndex = (currentPage - 1) * 10;
    
    // Build URL with parameters
    const url = new URL(keyObj.endpoint);
    url.searchParams.append('key', keyObj.key);
    url.searchParams.append('cx', keyObj.cx);
    url.searchParams.append('q', cleanQuery);
    url.searchParams.append('start', startIndex.toString());
    url.searchParams.append('num', '10');  // Max 10 results per page
    url.searchParams.append('safe', 'off');  // SafeSearch off for more results
    
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    
    try {
        console.log(`[Google CSE] Searching page ${currentPage}: "${cleanQuery}"`);
        console.log(`[Google CSE] Using cx: ${keyObj.cx}`);
        
        const res = await fetch(url.toString(), {
            method: "GET",
            headers: { 
                "User-Agent": "AI-Assistant/1.0",
                "Accept": "application/json"
            },
            signal: controller.signal
        });
        
        clearTimeout(timeout);
        
        if (!res.ok) {
            const errorText = await res.text();
            console.error(`[Google CSE] Error response: ${errorText}`);
            throw new Error(`Google CSE Error ${res.status}: ${errorText.substring(0, 200)}`);
        }
        
        const data = await res.json();
        
        // Format response
        let formattedResponse = formatGoogleCSEResponse(data, cleanQuery, currentPage);
        
        return {
            choices: [{
                message: {
                    content: formattedResponse,
                    provider: keyObj.name,
                    raw_data: data,
                    currentPage: currentPage,
                    hasNextPage: data.queries && data.queries.nextPage ? true : false,
                    totalResults: data.searchInformation?.totalResults || 0
                },
                finish_reason: "stop"
            }]
        };
        
    } catch (error) {
        clearTimeout(timeout);
        console.error(`[Google CSE] Error:`, error);
        throw error;
    }
}

function formatGoogleCSEResponse(data, query, currentPage) {
    let output = `# 🌐 Google Search Results for: "${query}"\n`;
    output += `## 📄 Page ${currentPage} of Results\n\n`;
    
    // Search info
    if (data.searchInformation) {
        const totalResults = parseInt(data.searchInformation.totalResults).toLocaleString();
        output += `**📊 Search Statistics:**\n`;
        output += `- **Total Results**: ${totalResults}\n`;
        output += `- **Search Time**: ${data.searchInformation.searchTime} seconds\n\n`;
    }
    
    // Page navigation
    output += `### 📑 Page Navigation\n`;
    output += `- **Current Page**: ${currentPage}\n`;
    output += `- **Results per page**: 10\n`;
    
    if (data.queries) {
        if (data.queries.nextPage) {
            output += `- **Next Page**: Type \`"${query} page:${currentPage + 1}"\` for more results\n`;
        }
        if (data.queries.previousPage) {
            output += `- **Previous Page**: Type \`"${query} page:${currentPage - 1}"\` for previous results\n`;
        }
    }
    
    output += `- **Analyze All Pages**: Type \`"analyze all pages for ${query}"\` for complete analysis\n\n`;
    
    // Search results
    if (data.items && data.items.length > 0) {
        output += `## 🌐 Search Results (Page ${currentPage})\n\n`;
        const startIndex = (currentPage - 1) * 10 + 1;
        
        data.items.forEach((item, idx) => {
            const globalIdx = startIndex + idx;
            output += `### ${globalIdx}. ${item.title}\n`;
            output += `- **Link**: ${item.link}\n`;
            if (item.snippet) output += `- **Snippet**: ${item.snippet}\n`;
            if (item.displayLink) output += `- **Source**: ${item.displayLink}\n`;
            output += `\n`;
        });
    } else if (data.error) {
        output += `## ❌ API Error\n\n`;
        output += `**Error**: ${data.error.message}\n`;
        output += `**Code**: ${data.error.code}\n\n`;
    } else {
        output += `## ❌ No results found\n\n`;
        output += `Try a different search term or check your spelling.\n\n`;
    }
    
    // Usage tips
    output += `---\n`;
    output += `### 💡 Tips for better results:\n`;
    output += `- Use \`page:2\`, \`page:3\` etc. to see more results\n`;
    output += `- Type \`analyze all pages for [query]\` for comprehensive analysis\n`;
    output += `- Be more specific for better results\n`;
    output += `- This searches: Wikipedia, GitHub, Stack Overflow, Reddit, Medium, NY Times, BBC, CNN, TechCrunch, The Verge\n`;
    
    return output;
}
// Create key pool instance - ADD THIS RIGHT HERE
const keyPool = new KeyPool(API_KEYS);

// ─── Rate Limiter ───────────────────────────────────────
const _rateLimiter = new Map();

function getClientIP(req) {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) return forwarded.split(',')[0].trim();
    const remote = req.socket.remoteAddress || '';
    return remote.replace(/^::ffff:/, '');
}

function checkRateLimit(ip, limit = 30, windowMs = 60000) {
    if (ip === '0.0.0.0' || ip === '::1' || ip === 'localhost') {
        limit = limit * 5;
    }
    const now = Date.now();
    let record = _rateLimiter.get(ip);
    if (!record || now > record.resetAt) {
        record = { count: 1, resetAt: now + windowMs };
        _rateLimiter.set(ip, record);
        return true;
    }
    record.count++;
    if (record.count > limit) return false;
    return true;
}

function isValidYouTubeId(id) {
    return typeof id === 'string' && /^[a-zA-Z0-9_-]{11}$/.test(id);
}

const MAX_BODY_CHARS = 12 * 1024 * 1024;
function rejectBigBody(req, res) {
    req.removeAllListeners('data');
    req.removeAllListeners('end');
    if (!res.headersSent) {
        res.writeHead(413, { 'Content-Type': 'application/json', 'Connection': 'close' });
        res.end(JSON.stringify({ error: 'Request body too large' }), () => req.destroy());
    } else {
        req.destroy();
    }
}

let _chatPageCache = null;
function getChatPage() {
    const possiblePaths = [
        './ai_chat.html',
        '/root/ChatGPT/ai_chat.html',
        './chat.html',
        '/sdcard/Android/media/com.termux/chat.html'
    ];
    for (const p of possiblePaths) {
        let st;
        try { st = fs.statSync(p); } catch (e) { continue; }
        if (!st.isFile()) continue;
        const c = _chatPageCache;
        if (c && c.path === p && c.mtimeMs === st.mtimeMs && c.size === st.size) return c;
        const raw = fs.readFileSync(p);
        _chatPageCache = {
            path: p,
            mtimeMs: st.mtimeMs,
            size: st.size,
            raw,
            gz: zlib.gzipSync(raw, { level: 6 }),
            etag: 'W/"' + st.size.toString(16) + '-' + Math.floor(st.mtimeMs).toString(16) + '"'
        };
        console.log(`[HTML] Loaded from ${p}`);
        return _chatPageCache;
    }
    throw new Error('HTML file not found');
}

setInterval(() => {
    const now = Date.now();
    for (const [ip, record] of _rateLimiter) {
        if (now > record.resetAt) _rateLimiter.delete(ip);
    }
}, 300000);
// Store conversation in Memory AI
// ─── Memory Conversations with Size Limit & TTL ──────────
const memoryConversations = new Map();
const captionCache = new TTLCache(1800000, 100); // 30min TTL, max 100 videos
const pdfCaptionTextCache = new TTLCache(1800000, 50);
const MAX_MEMORY_CONVERSATIONS = 100;
const CONVERSATION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// Periodic cleanup: remove expired conversations every hour
setInterval(() => {
    const now = Date.now();
    let removed = 0;
    for (const [key, val] of memoryConversations) {
        if (!val.timestamp || now - val.timestamp > CONVERSATION_TTL_MS) {
            memoryConversations.delete(key);
            removed++;
        }
    }
    if (removed > 0) console.log(`[Memory] Cleaned up ${removed} expired conversations`);
}, 3600000);

class BlackboxSessionManager {
    constructor() {
        this.sessions = [
            { sessionId: process.env.BLACKBOX_SESSION_ID || "cadd7e68-3dd2-41c5-b8bc-c3435fc2a3c1", validated: process.env.BLACKBOX_VALIDATED || "a38f5889-8fef-46d4-8ede-bf4668b6a9bb", lastUsed: 0, failCount: 0, alive: true, lastChecked: 0 },
        ];
        this.currentIdx = 0;
    }

    getSession() {
        const now = Date.now();
        let available = this.sessions.filter(s => s.alive && now - s.lastUsed > 10000 && s.failCount < 3);
        if (available.length === 0) {
            const anyAlive = this.sessions.some(s => s.alive);
            if (!anyAlive) {
                console.log('[SessionMgr] All sessions dead — resetting failCounts');
                this.sessions.forEach(s => { s.failCount = 0; s.alive = true; });
                available = this.sessions;
            } else {
                this.currentIdx = (this.currentIdx + 1) % this.sessions.length;
                return this.sessions[this.currentIdx];
            }
        }
        available.sort((a, b) => a.failCount - b.failCount);
        const selected = available[0];
        selected.lastUsed = now;
        return selected;
    }

    reportSuccess(sessionId) {
        const s = this.sessions.find(s => s.sessionId === sessionId);
        if (s) { s.failCount = Math.max(0, s.failCount - 1); s.alive = true; }
    }

    reportFailure(sessionId) {
        const s = this.sessions.find(s => s.sessionId === sessionId);
        if (s) {
            s.failCount++;
            if (s.failCount >= 5) { s.alive = false; console.log(`[SessionMgr] Session ${sessionId.slice(0,8)}… marked dead`); }
        }
    }

    addSession(sessionId, validated) {
        const exists = this.sessions.find(s => s.sessionId === sessionId);
        if (exists) { exists.failCount = 0; exists.alive = true; return false; }
        this.sessions.push({ sessionId, validated, lastUsed: 0, failCount: 0, alive: true, lastChecked: 0 });
        console.log(`[SessionMgr] Added new session: ${sessionId.slice(0, 8)}…`);
        return true;
    }

    getStatus() {
        return this.sessions.map(s => ({
            sessionId: s.sessionId.slice(0, 8) + '…',
            alive: s.alive,
            failCount: s.failCount,
            lastUsed: s.lastUsed ? new Date(s.lastUsed).toISOString() : 'never',
            lastChecked: s.lastChecked ? new Date(s.lastChecked).toISOString() : 'never'
        }));
    }

    markExpired(sessionId) {
        const s = this.sessions.find(s => s.sessionId === sessionId);
        if (s) { s.failCount = 99; s.alive = false; }
    }
}

// Create global instance
const blackboxSessionManager = new BlackboxSessionManager();


async function validateBlackboxSession(session) {
    const probe = {
        messages: [{ role: 'user', content: 'hi', id: 'probe' }],
        id: 'probe',
        previewToken: null,
        userId: null,
        codeModelMode: false,
        trendingAgentMode: { mode: false, id: '' },
        isMicMode: false,
        userSystemPrompt: null,
        maxTokens: 50,
        playgroundTopP: null,
        playgroundTemperature: null,
        isChromeExt: false,
        githubToken: '',
        clickedAnswer2: false,
        clickedAnswer3: false,
        clickedForceWebSearch: false,
        visitFromDelta: false,
        isMemoryEnabled: false,
        mobileClient: false,
        userSelectedModel: null,
        agentMode: { mode: false, id: '', name: '' },
        validated: session.validated,
        imageGenerationMode: false,
        imageGenMode: 'autoMode',
        webSearchModePrompt: false,
        deepSearchMode: false,
        promptSelection: '',
        domains: null,
        vscodeClient: false,
        codeInterpreterMode: false,
        customProfile: { name: '', occupation: '', traits: [], additionalInfo: '', enableNewChats: false },
        webSearchModeOption: { autoMode: true, webMode: false, offlineMode: false },
        session: null,
        isPremium: false,
        teamAccount: '',
        subscriptionCache: null,
        beastMode: false,
        reasoningMode: false,
        designerMode: false,
        workspaceId: '',
        asyncMode: false,
        integrations: {},
        isTaskPersistent: false,
        selectedElement: null
    };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
        const res = await fetch('https://app.blackbox.ai/api/chat', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36',
                'Origin': 'https://app.blackbox.ai',
                'Referer': 'https://app.blackbox.ai/',
                'Cookie': `sessionId=${session.sessionId}`
            },
            body: JSON.stringify(probe),
            signal: controller.signal
        });
        clearTimeout(timeout);
        session.lastChecked = Date.now();
        if (res.status === 401 || res.status === 403) {
            blackboxSessionManager.markExpired(session.sessionId);
            return { ok: false, status: res.status, reason: 'auth_expired' };
        }
        if (!res.ok) {
            return { ok: false, status: res.status, reason: 'http_error' };
        }
        let body = '';
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        for (let i = 0; i < 5; i++) {
            const { done, value } = await reader.read();
            if (done) break;
            body += dec.decode(value, { stream: true });
            if (body.length > 20) break;
        }
        reader.cancel();
        const alive = body.trim().length > 0 && !body.includes('"error"');
        if (!alive) blackboxSessionManager.markExpired(session.sessionId);
        else { session.failCount = 0; session.alive = true; }
        return { ok: alive, status: res.status, reason: alive ? 'ok' : 'empty_response' };
    } catch (e) {
        clearTimeout(timeout);
        return { ok: false, status: 0, reason: e.name === 'AbortError' ? 'timeout' : e.message };
    }
}




// ─── Blackbox AI Handler (Free, streaming) ────────────────────────
function sanitizeBlackboxResponse(content) {
    if (!content) return '';

    if (content.includes('data: ') && (content.includes('"type"') || content.includes('[DONE]'))) {
        let extracted = '';
        for (const line of content.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data: ')) continue;
            const raw = trimmed.slice(6);
            if (raw === '[DONE]') break;
            try {
                const obj = JSON.parse(raw);
                if (obj.type === 'error' || obj.errorText) {
                    throw new Error(`Blackbox: ${obj.errorText || obj.error || 'SSE error'}`);
                }
                const chunk =
                    obj.content ||
                    obj.delta?.content ||
                    obj.choices?.[0]?.delta?.content ||
                    obj.choices?.[0]?.message?.content ||
                    '';
                extracted += chunk;
            } catch (e) {
                if (e.message.startsWith('Blackbox:')) throw e;
            }
        }
        if (extracted) content = extracted;
    }

    return content
        .replace(/^\$\$\$[^\n]*\n?/gm, '')
        .replace(/^Generated by Blackbox AI[^\n]*\n?/gi, '')
        .replace(/^Here(?:'s| is) the continuation[^\n]*\n?/gi, '')
        .replace(/^Continuing from[^\n]*\n?/gi, '')
        .replace(/^Sure[,!. ][^\n]{0,80}\n?/gi, '')
        .replace(/^\[CONTINUATION\][^\n]*\n?/gi, '')
        .replace(/^Of course[,!. ][^\n]{0,80}\n?/gi, '')
        .replace(/^(?:Here you go|No problem)[^\n]*\n?/gi, '')
        .trim();
}

function detectCodeTruncation(content) {
    if (!content) return false;
    const lines = content.split('\n');
    const fences = (content.match(/^```/gm) || []).length;
    if (fences % 2 !== 0) return true;
    const lastFenceOpenIdx = content.search(/```[\w]/);
    const lastFenceCloseIdx = content.lastIndexOf('\n```');
    if (lastFenceOpenIdx > -1 && lastFenceCloseIdx <= lastFenceOpenIdx) return true;

    // Lower threshold: 100 non-empty code lines without closing fence
    const nonEmptyCodeLines = lines.filter(l => l.trim() && !l.startsWith('```') && !l.startsWith('#!')).length;
    if (nonEmptyCodeLines >= 100 && !/\n```\s*$/.test(content.slice(-120))) return true;

    const lastLine = (lines[lines.length - 1] || '').trimEnd();
    const secondLastLine = (lines[lines.length - 2] || '').trimEnd();
    const thirdLastLine = (lines[lines.length - 3] || '').trimEnd();

    // Trailing operators / incomplete expressions
    if (/[a-zA-Z_,({\[=\\]$/.test(lastLine)) return true;
    if (/(\+|-|\*|\/|%|\||&|and |or |not |in |is )\s*$/.test(lastLine)) return true;

    // Incomplete function/class/decorator
    if (/^(\s*def |\s*class |\s*async def )/.test(lastLine) && !lastLine.endsWith(':')) return true;
    if (/^(\s*def |\s*class )/.test(secondLastLine) && lastLine === '') return true;
    if (/^\s*@\w+/.test(lastLine) && !lastLine.includes('(')) return true;
    if (/^\s*@\w+.*$/.test(lastLine) && /^\s*$/.test(lines[lines.length - 1] || '')) return true;

    // Open bracket on its own line
    if (/^[\s]*[({[\s]*$/.test(lastLine) && lastLine.trim().length <= 1) return true;

    // Unmatched quote on last line
    if ((lastLine.match(/['"]/g) || []).length % 2 !== 0) return true;

    // Incomplete statement (return/yield/raise/print/assert without end)
    if (/^\s*(return|yield|raise|print|assert)\s+\S/.test(lastLine) && !/[;,)}\]]\s*$/.test(lastLine) && !/['"`]\s*$/.test(lastLine)) return true;

    // Stub/placeholder comments — AI decided to skip writing the code
    if (/^\s*#\s*(\.\.\.|\.\.\.|TODO|FIXME|rest is similar|similar to above|continues?|implementation here|add more|etc\.?)\s*$/i.test(lastLine)) return true;
    if (/^\s*pass\s*$/.test(lastLine) && /^(\s*def |\s*class )/.test(thirdLastLine)) return true;

    // Inside a multiline string (odd count of triple quotes)
    const tripleDouble = (content.match(/"""/g) || []).length;
    const tripleSingle = (content.match(/'''/g) || []).length;
    if (tripleDouble % 2 !== 0 || tripleSingle % 2 !== 0) return true;

    // Trailing comma on last non-empty line (more items expected)
    const trimmedLast = lastLine.trim();
    if (trimmedLast.endsWith(',') && !trimmedLast.startsWith('#')) return true;

    // Last line is just an open bracket type
    if (/^[\[{(]\s*$/.test(trimmedLast)) return true;

    return false;
}


async function callBlackboxAI(keyObj, messages, maxTokens = 8192) {
    const lastMessage = messages[messages.length - 1];
    const userQuery = lastMessage.content;
    const session = blackboxSessionManager.getSession();
    
    const chatId = Math.random().toString(36).substring(2, 10);
    
    // Build conversation history (keep last 10 messages)
    let chatHistory = [];
    for (let i = Math.max(0, messages.length - 10); i < messages.length - 1; i++) {
        const msg = messages[i];
        chatHistory.push({
            role: msg.role,
            content: msg.content,
            id: Math.random().toString(36).substring(2, 10)
        });
    }
    
    chatHistory.push({
        role: "user",
        content: userQuery,
        id: chatId
    });
    
        const requestBody = {
        messages: chatHistory,
        id: chatId,
        previewToken: null,
        userId: session.userId || null,
        codeModelMode: false,
        agentMode: {},
        trendingAgentMode: {},
        isMicMode: false,
        userSystemPrompt: null,
        maxTokens: Math.min(maxTokens, 8192),
        playgroundTopP: null,
        playgroundTemperature: null,
        isChromeExt: false,
        githubToken: "",
        clickedAnswer2: false,
        clickedAnswer3: false,
        clickedForceWebSearch: false,
        visitFromDelta: false,
        isMemoryEnabled: false,
        mobileClient: false,
        userSelectedModel: null,
        validated: session.validated,
        imageGenerationMode: false,
        webSearchModePrompt: false,
        deepSearchMode: false,
        domains: null,
        vscodeClient: false,
        codeInterpreterMode: false,
        isPremium: false,
        beastMode: false,
        reasoningMode: false,
        designerMode: false,
        workspaceId: "",
        asyncMode: false
    };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45000);
    
    try {
        console.log(`[Blackbox] Sending request: "${userQuery.substring(0, 50)}..."`);

        let fullReply = '';

        const _primaryHeaders = {
            'Content-Type': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Accept': 'text/event-stream, */*',
            'Origin': 'https://www.blackbox.ai',
            'Referer': 'https://www.blackbox.ai/',
        };
        if (session.sessionId && session.sessionId !== 'cadd7e68-3dd2-41c5-b8bc-c3435fc2a3c1') {
            _primaryHeaders['Cookie'] = `sessionId=${session.sessionId}`;
        }
        const response = await fetch('https://www.blackbox.ai/api/chat', {
            method: 'POST',
            headers: _primaryHeaders,
            body: JSON.stringify(requestBody),
            signal: controller.signal
        });
        
        clearTimeout(timeout);
        
        if (response.status === 401 || response.status === 403) {
            blackboxSessionManager.markExpired(session.sessionId);
            console.log(`[Blackbox] Session ${session.sessionId.slice(0,8)}… expired (${response.status}) — marked dead, retrying with next`);
            const nextSession = blackboxSessionManager.getSession();
            if (nextSession.sessionId !== session.sessionId) {
                requestBody.validated = nextSession.validated;
                const retryRes = await fetch('https://api.blackbox.ai/chat', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                        'Accept': 'text/event-stream, */*',
                        'Origin': 'https://www.blackbox.ai',
                        'Referer': 'https://www.blackbox.ai/',
                        'Cookie': `sessionId=${nextSession.sessionId}`
                    },
                    body: JSON.stringify(requestBody),
                    signal: controller.signal
                });
                if (!retryRes.ok) throw new Error(`Blackbox API Error ${retryRes.status} (after session rotation)`);
                clearTimeout(timeout);
                let retryReply = '';
                const retryReader = retryRes.body.getReader();
                const retryDecoder = new TextDecoder();
                while (true) {
                    const { done, value } = await retryReader.read();
                    if (done) break;
                    retryReply += retryDecoder.decode(value, { stream: true });
                }
                fullReply = retryReply;
            } else {
                throw new Error(`Blackbox API Error ${response.status}: all sessions expired`);
            }
        } else if (!response.ok) {
            throw new Error(`Blackbox API Error ${response.status}: ${await response.text()}`);
        } else {
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                fullReply += decoder.decode(value, { stream: true });
            }
        }
        
        fullReply = sanitizeBlackboxResponse(
            fullReply
                .replace(/<script[\s\S]*?<\/script>/gi, '')
                .replace(/<style[\s\S]*?<\/style>/gi, '')
                .trim()
        );
        
        if (!fullReply) {
            throw new Error('Empty response from Blackbox');
        }

        if (fullReply.trim() === 'Deprecated endpoint' || fullReply.toLowerCase().startsWith('deprecated')) {
            console.log('[Blackbox] Deprecated response — trying endpoint/format variants...');
            const _variants = [
                { url: 'https://www.blackbox.ai/api/chat',  origin: 'https://www.blackbox.ai', validated: null,                  noSession: true },
                { url: 'https://www.blackbox.ai/api/chat',  origin: 'https://www.blackbox.ai', validated: session.validated,     noSession: false },
                { url: 'https://api.blackbox.ai/chat',      origin: 'https://www.blackbox.ai', validated: null,                  noSession: true },
                { url: 'https://api.blackbox.ai/chat',      origin: 'https://www.blackbox.ai', validated: session.validated,     noSession: false },
            ];
            for (const _v of _variants) {
                const _rb2 = { ...requestBody };
                _rb2.agentMode = { mode: false, id: '', name: '' };
                _rb2.trendingAgentMode = { mode: false, id: '' };
                _rb2.validated = _v.validated;
                if (!_rb2.validated) delete _rb2.validated;
                const _ctrl2 = new AbortController();
                const _t2 = setTimeout(() => _ctrl2.abort(), 40000);
                try {
                    const _headers2 = {
                        'Content-Type': 'application/json',
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                        'Origin': _v.origin,
                        'Referer': `${_v.origin}/`,
                    };
                    if (!_v.noSession && session.sessionId) {
                        _headers2['Cookie'] = `sessionId=${session.sessionId}`;
                    }
                    const _res2 = await fetch(_v.url, {
                        method: 'POST',
                        headers: _headers2,
                        body: JSON.stringify(_rb2),
                        signal: _ctrl2.signal
                    });
                    clearTimeout(_t2);
                    if (!_res2.ok) { console.log(`[Blackbox] Variant ${_v.url} → HTTP ${_res2.status}`); continue; }
                    let _r2 = '';
                    const _rdr2 = _res2.body.getReader();
                    const _dec2 = new TextDecoder();
                    while (true) {
                        const { done, value } = await _rdr2.read();
                        if (done) break;
                        _r2 += _dec2.decode(value, { stream: true });
                    }
                    _r2 = sanitizeBlackboxResponse(_r2.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').trim());
                    console.log(`[Blackbox] Variant ${_v.url} validated=${!!_v.validated} → ${_r2.length} chars: ${_r2.substring(0,60)}`);
                    if (_r2 && !_r2.toLowerCase().startsWith('deprecated') && _r2.length > 30) {
                        fullReply = _r2;
                        console.log(`[Blackbox] Variant succeeded: ${fullReply.length} chars`);
                        break;
                    }
                } catch (_e2) {
                    clearTimeout(_t2);
                    console.log(`[Blackbox] Variant ${_v.url} threw: ${_e2.message}`);
                }
            }
            if (fullReply.trim() === 'Deprecated endpoint' || fullReply.length <= 19) {
                throw new Error('Blackbox API endpoint changed — all 4 variants deprecated. Update sessionId/validated in .env or switch provider.');
            }
        }
        
        console.log(`[Blackbox] Received ${fullReply.length} chars response`);
        
        // Report success to session manager
        blackboxSessionManager.reportSuccess(session.sessionId);
        
        const isTruncated = detectCodeTruncation(fullReply);
        if (isTruncated) {
            console.log(`[Blackbox] Detected code truncation — will continue automatically`);
        }
        return {
            choices: [{
                message: {
                    content: fullReply,
                    provider: keyObj.name,
                    model: 'blackbox'
                },
                finish_reason: isTruncated ? "length" : "stop"
            }]
        };
        
    } catch (error) {
        clearTimeout(timeout);
        blackboxSessionManager.reportFailure(session.sessionId);
        console.error(`[Blackbox] Error:`, error.message);
        throw error;
    }
}


async function callAPI(keyObj, messages, maxTokens = 4096) {
    if (!keyObj || !keyObj.provider) {
        throw new Error('Invalid keyObj passed to callAPI');
    }
    
    if (keyObj.provider === 'kimi-search') {
        return await callKimiWithSearch(keyObj, messages, maxTokens);
    }
    
    // ── Blackbox AI routing ──────────────────────────────────────
    if (keyObj.provider === 'blackbox') {
        return await callBlackboxAI(keyObj, messages, maxTokens);
    }
    
    if (keyObj.provider === 'puter-gemini' || keyObj.provider === 'puter-gpt-nano') {
        return await callPuterAI(keyObj);
    }
    // Route to Google Jobs
    if (keyObj.provider === 'serpapi_jobs') {
        return await callGoogleJobs(keyObj, messages, maxTokens);
    }
    // Route to Google CSE
    if (keyObj.provider === 'google_cse') {
        return await callGoogleCSE(keyObj, messages, maxTokens);
    }
    // Route to Linkup
    if (keyObj.provider === 'linkup') {
        return await callLinkup(keyObj, messages, maxTokens);
    }
    // Route to SerpApi if provider is serpapi
   if (keyObj.provider === 'serpapi') {
        const lastMessage = messages[messages.length - 1];
        const query = lastMessage.content;

        // Check if user wants to analyze all pages
        if (query.toLowerCase().includes('analyze all pages for')) {
            const cleanQuery = query.replace(/analyze all pages for/i, '').trim();
            const { results, totalPages } = await analyzeAllPages(keyObj, cleanQuery);

            // Aggregate all content into one formatted response
            let combined = `# 📊 Full Analysis: "${cleanQuery}"\n\n`;
            combined += `**Pages analyzed:** ${totalPages}\n\n`;
            results.forEach((pageData, idx) => {
                if (pageData.reconstructed_markdown) {
                    combined += `## Page ${idx + 1} Summary\n${pageData.reconstructed_markdown}\n\n`;
                }
                if (pageData.organic_results) {
                    pageData.organic_results.forEach((item, i) => {
                        combined += `- **[${item.title}](${item.link})** — ${item.snippet || ''}\n`;
                    });
                    combined += '\n';
                }
            });

            return {
                choices: [{
                    message: {
                        content: combined,
                        provider: 'SerpAPI Multi-Page',
                        totalPages
                    },
                    finish_reason: 'stop'
                }]
            };
        }

        // Check if user wants a specific page
        if (query.toLowerCase().includes('page:')) {
            return await callSerpAPIMultiPage(keyObj, messages, maxTokens);
        }

        // Default to single page
        return await callSerpAPIMultiPage(keyObj, messages, maxTokens);
    }
    
    // ── GNews provider routing ──
    if (keyObj.provider === 'gnews') {
        const lastMessage = messages[messages.length - 1];
        let query = lastMessage.content;
        
        const gnewsKey = process.env.GNEWS_KEY;
        if (!gnewsKey) throw new Error('GNews API key not configured');
        
        // Determine if it's a category request or search
        const categories = ['technology', 'business', 'entertainment', 'health', 'science', 'sports', 'world', 'general'];
        const isCategory = categories.some(c => query.toLowerCase().trim() === c || 
            query.toLowerCase().includes(`headlines ${c}`) ||
            query.toLowerCase().includes(`${c} news`));
        
        let gnewsUrl;
        if (isCategory) {
            const category = categories.find(c => query.toLowerCase().includes(c)) || 'technology';
            gnewsUrl = `https://gnews.io/api/v4/top-headlines?category=${category}&lang=en&max=10&apikey=${gnewsKey}`;
            } else {
            gnewsUrl = `https://gnews.io/api/v4/search?q=${encodeURIComponent(query)}&lang=en&max=10&apikey=${gnewsKey}`;
            }
        
        const response = await fetch(gnewsUrl, { headers: { 'User-Agent': 'AI-Assistant/1.0' } });
        const data = await response.json();
        
        let output = `# 📰 ${isCategory ? query + ' Headlines' : 'News: "' + query + '"'}\n\n`;
        if (data.articles && data.articles.length > 0) {
            data.articles.forEach((article, idx) => {
                output += `### ${idx + 1}. ${article.title}\n`;
                output += `- **Source**: ${article.source?.name || 'Unknown'}\n`;
                output += `- **Date**: ${article.publishedAt?.substring(0, 10) || 'N/A'}\n`;
                if (article.description) output += `- **Summary**: ${article.description}\n`;
                if (article.url) output += `- [Read Full Article](${article.url})\n`;
                output += `\n`;
            });
        } else {
            output += 'No articles found.\n';
        }
        
        return {
            choices: [{ message: { content: output, provider: 'GNews' }, finish_reason: 'stop' }]
        };
    }
    
    // Original API handling for other providers
    let cleanMessages = [...messages];
    if (keyObj.provider && keyObj.provider.startsWith('aiml-')) {
        // Remove trailing assistant messages
        while (cleanMessages.length > 0 && 
               cleanMessages[cleanMessages.length - 1].role === 'assistant') {
            cleanMessages.pop();
        }
        // Ensure at least one message remains
        if (cleanMessages.length === 0) {
            cleanMessages = messages.slice(-1);
        }
    }

    const body = JSON.stringify({
        model: keyObj.model,
        messages: cleanMessages,
        max_tokens: maxTokens,
        stream: false,
        temperature: 0.7
    });
    
    const controller = new AbortController();
    const timeoutMap = {
        blackbox: 45000,
        pawan: 20000,
        'chatanywhere': 30000,
        'kimi': 35000,
        'kimi-32k': 45000,
        'kimi-128k': 60000,
        'kimi-search': 45000,
        'GPT-Nano': 45000,
        'chatanywhere1': 30000,
        'sambanova-deepseek': 45000,
        'sambanova-gptoss': 45000,
        'openrouter-deepseek': 40000,
        'openrouter-r1': 60000,
        serpapi: 25000,
        google_cse: 20000,
        gnews: 15000,
        linkup: 45000,
        'ollama': 120000
    };
    const timeoutMs = timeoutMap[keyObj.provider] ?? 60000;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    
    try {
        console.log(`[API] ${keyObj.name} → ${new URL(keyObj.endpoint).hostname}...`);
        
        const res = await fetch(keyObj.endpoint, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${keyObj.key}`,
                "User-Agent": "AI-Assistant/1.0"
            },
            body,
            signal: controller.signal
        });

        clearTimeout(timeout);
        console.log(`[API] Response status: ${res.status}`);

        if (!res.ok) {
            const errorText = await res.text();
            console.error(`[API] Error response: ${errorText}`);
            throw new Error(`API Error ${res.status}: ${errorText.substring(0, 200)}`);
        }

        const data = await res.json();

        if (data.error) {
            throw new Error(data.error.message || JSON.stringify(data.error));
        }

        return data;
    } catch (error) {
        clearTimeout(timeout);
        if (error.name === 'AbortError') {
            throw new Error('Request timed out after 120 seconds');
        }
        throw error;
    }
}

class SmartContinuationManager {
    constructor() {
        this.activeContinuations = new Map();
    }
    
    async sendCompleteResponse(messages, res, provider = null, sessionId = null) {
        // Search/jobs providers: single-shot, no continuation needed
        const searchProviders = ['serpapi', 'google_cse', 'serpapi_jobs', 'gnews','linkup'];
        if (provider && searchProviders.includes(provider) && provider !== 'auto') {
            const keyObj = keyPool.getKey(provider);
            if (!keyObj) {
                res.writeHead(503, {'Content-Type': 'application/json'});
                res.end(JSON.stringify({ error: { message: 'No API keys available for this provider' } }));
                return;
            }
            try {
                const data = await callAPI(keyObj, messages, 4096);
                keyPool.releaseKey(keyObj);
                res.writeHead(200, {'Content-Type': 'application/json'});
                res.end(JSON.stringify(data));
            } catch (e) {
                keyPool.releaseKey(keyObj, e);
                res.writeHead(500, {'Content-Type': 'application/json'});
                res.end(JSON.stringify({ error: { message: e.message } }));
            }
            return;
        }

        if (!sessionId) sessionId = Date.now().toString();
        let session = this.activeContinuations.get(sessionId);

        if (!session) {
            session = {
                id: sessionId,
                fullResponse: '',
                continuationCount: 0,
                lastPartial: '',
                isComplete: false,
                originalQuery: messages[messages.length - 1]?.content || ''
            };
            this.activeContinuations.set(sessionId, session);
        }

        const keyObj = keyPool.getKey(provider);
        if (!keyObj) {
            res.writeHead(503, {'Content-Type': 'application/json'});
            res.end(JSON.stringify({ error: { message: 'No API keys available' } }));
            return;
        }
        
                try {
            let currentMessages = [...messages];
            let maxContinuations = keyObj.provider === 'blackbox' ? 50 : 30;
            let hasMore = true;
            let stagnantCount = 0;
            let lastLength = 0;
            let consecutiveSmallChunks = 0;

            while (hasMore && session.continuationCount < maxContinuations) {
                const isLongQuery = this.isLongQuery(messages);
                const maxTokens = isLongQuery ? 16000 : 12000;

                console.log(`[Pass ${session.continuationCount + 1}] tokens=${maxTokens} accumulated=${session.fullResponse.length}`);

                let data;
                try {
                    const _bbParallel = keyObj.provider === 'blackbox' && session.continuationCount >= 1;
                    if (_bbParallel) {
                        const parallelBest = await this.parallelContinuation(keyObj, session.fullResponse, messages, session.originalQuery);
                        if (parallelBest) {
                            data = {
                                choices: [{
                                    message: { content: parallelBest },
                                    finish_reason: detectCodeTruncation(parallelBest) ? 'length' : 'stop'
                                }]
                            };
                        } else {
                            data = await this.callAPIWithRetry(keyObj, currentMessages, maxTokens);
                        }
                    } else {
                        data = await this.callAPIWithRetry(keyObj, currentMessages, maxTokens);
                    }
                } catch(fetchErr) {
                    console.log(`[Pass ${session.continuationCount + 1}] fetch error: ${fetchErr.message}`);
                    break;
                }

                const rawContent = data?.choices?.[0]?.message?.content || '';
                const finishReason = data?.choices?.[0]?.finish_reason || 'stop';

                if (!rawContent || rawContent.trim().length < 5) {
                    stagnantCount++;
                    console.log(`[Pass ${session.continuationCount + 1}] empty chunk, stagnant=${stagnantCount}`);
                    if (stagnantCount >= 3) break;
                    await this.delay(600);
                    continue;
                }

                const prevLen = session.fullResponse.length;

                if (session.continuationCount === 0) {
                    session.fullResponse = rawContent;
                } else {
                    session.fullResponse = this.smartMerge(session.fullResponse, rawContent);
                }

                const grew = session.fullResponse.length - prevLen;
                if (grew <= 0) {
                    // Zero or negative growth (duplicate/discarded by smartMerge)
                    consecutiveSmallChunks++;
                    if (consecutiveSmallChunks >= 8) {
                        console.log(`[Pass] 8 consecutive zero-growth chunks, stopping`);
                        break;
                    }
                } else if (grew < 20) {
                    // Tiny but real growth — count softer
                    consecutiveSmallChunks = Math.max(0, consecutiveSmallChunks - 1);
                    stagnantCount = Math.max(0, stagnantCount - 1);
                } else {
                    // Real growth resets both counters
                    consecutiveSmallChunks = 0;
                    stagnantCount = 0;
                }

                session.continuationCount++;
                lastLength = session.fullResponse.length;

                // ── Completion detection ──────────────────────────────
                const openFences = (session.fullResponse.match(/^```/gm) || []).length;
                const hasOpenFence = openFences % 2 !== 0;
                const incomplete = !this.isResponseComplete(session.fullResponse);
                const tokenCut = finishReason === 'length';
                const endsAbruptly = /[a-zA-Z_,({\[]\s*$/.test(session.fullResponse.slice(-80));

                // ── Global scope check: Python scripts must have main() entry point ──
                const _isPy = session.fullResponse.includes('#!/usr/bin/env python') ||
                              /^(?:import |from \w+ import)/m.test(session.fullResponse);
                const _hasPyMain = /if\s+__name__\s*==\s*['"]__main__['"]/m.test(session.fullResponse);
                const _classDefs = (session.fullResponse.match(/^class \w+/gm) || []).length;
                const _defCount = (session.fullResponse.match(/^\s*def \w+/gm) || []).length;
                // Script is globally incomplete if: no main(), or too few defs for a "comprehensive tool"
                const globallyIncomplete = _isPy && (!_hasPyMain || (_classDefs > 0 && _defCount < 5));
                // Size-based: if original query asked for advanced/comprehensive tool, keep going until big
                const isBigTask = (session.originalQuery || '').toLowerCase().match(/advanced|comprehensive|complete|full|multiple|all sources/);
                const tooShort = !!isBigTask && session.fullResponse.length < 60000;

                hasMore = (tokenCut || incomplete || hasOpenFence || endsAbruptly || globallyIncomplete || tooShort)
                        && session.fullResponse.length > 30;

                console.log(`[Pass ${session.continuationCount}] grew=${grew} finish=${finishReason} incomplete=${incomplete} openFence=${hasOpenFence} abrupt=${endsAbruptly} globalIncomplete=${globallyIncomplete} tooShort=${tooShort} hasMore=${hasMore}`);

                if (hasMore) {
                    // Use a fresh key for continuation if available
                    const contKey = keyPool.getKey(provider !== 'auto' ? provider : null) || keyObj;

                    const _isBlackbox = keyObj.provider === 'blackbox';
                    currentMessages = [
                        {
                            role: 'system',
                            content: 'You are an AI that was cut off mid-response. Continue writing from the exact cut-off point. No preamble. No repetition. No summary. Output ONLY the continuation text starting from where you stopped.'
                        },
                        ...(_isBlackbox ? [
                            { role: 'user', content: messages[messages.length - 1]?.content || '' },
                            { role: 'assistant', content: session.fullResponse.slice(-3000) }
                        ] : []),
                        {
                            role: 'user',
                            content: this.buildContinuationPrompt(session.fullResponse, session.originalQuery || '')
                        }
                    ];

                    // Release and re-acquire key to avoid timeout on same connection
                    if (contKey !== keyObj) {
                        keyPool.releaseKey(contKey);
                    }

                    await this.delay(150);
                }
            }
            
            // ── Final post-processing ─────────────────────────────────────
            // 1. Deduplicate import blocks (identical consecutive import lines)
            session.fullResponse = session.fullResponse.replace(
                /((?:^(?:import |from )[^\n]+\n)+)\n*\1/gm,
                '$1'
            );

            // 2. Remove any double shebang
            session.fullResponse = session.fullResponse.replace(
                /(#!\/usr\/bin\/env python[^\n]*\n)([\s\S]*?)(#!\/usr\/bin\/env python[^\n]*\n)/,
                '$1$2'
            );

            // 3. Strip stray leading preamble lines the AI slipped into continuations
            session.fullResponse = session.fullResponse
                .split('\n')
                .filter((line, idx) => {
                    if (idx === 0) return true; // keep first line always
                    return !/^(Continuing\.{0,3}|Here(?:'s| is) the (?:rest|continuation)|Sure[,!. ]|Of course[,!. ])\s*$/i.test(line.trim());
                })
                .join('\n');

            // 4. Fence repair
            const _finalFences = (session.fullResponse.match(/^```/gm) || []).length;
            if (_finalFences % 2 !== 0) {
                console.log('[FenceRepair] Final: appending closing ``` (odd fence count)');
                session.fullResponse = session.fullResponse.trimEnd() + '\n```';
            }

            // 5. Final sanitize
            if (keyObj.provider === 'blackbox') {
                session.fullResponse = sanitizeBlackboxResponse(session.fullResponse);
            }

            keyPool.releaseKey(keyObj);
            
            // ── Send ONE single complete JSON response ──
            const parallelPasses = keyObj.provider === 'blackbox' && session.continuationCount > 1
                ? (session.continuationCount - 1) * 3
                : 0;
            const finalData = {
                choices: [{
                    message: {
                        content: session.fullResponse,
                        provider: keyObj.name,
                        isComplete: true,
                        totalContinuations: session.continuationCount,
                        segments: session.continuationCount + 1,
                        parallelCalls: parallelPasses
                    },
                    finish_reason: 'stop'
                }]
            };
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(finalData));
            
            // Clean up session after delay
            setTimeout(() => this.activeContinuations.delete(sessionId), 10000);
            
        } catch (e) {
            keyPool.releaseKey(keyObj, e);
            
            // Since we wait to send headers, we can safely send a normal error
            const errorData = {
                error: { message: e.message },
                partial: session.fullResponse || null
            };
            
            if (!res.headersSent) {
                res.writeHead(500, {'Content-Type': 'application/json'});
                res.end(JSON.stringify(errorData));
            } else {
                // Fallback just in case headers were sent earlier somehow
                res.end(JSON.stringify(errorData));
            }
        }
    }
    
    isLongQuery(messages) {
        const lastQuery = messages[messages.length - 1]?.content || '';
        const longIndicators = [
            'essay', 'detailed', 'comprehensive', 'explain in depth',
            'write a long', 'complete guide', 'advanced', 'full',
            'tutorial', 'learn', 'teach', 'course', 'lesson',
            'from scratch', 'step by step', 'step-by-step', 'beginner',
            'zero to hero', 'all about', 'examples', 'example',
            'complete code', 'full code', 'write a', 'generate a',
            'create a complete', 'implement', 'program',
            'script', 'tool', 'scraper', 'scraping', 'bot', 'automation',
            'class', 'module', 'library', 'framework', 'cli', 'argparse',
            'async', 'asyncio', 'aiohttp', 'requests', 'selenium',
            'playwright', 'beautifulsoup', 'pandas', 'flask', 'fastapi',
            'django', 'api', 'crawler', 'spider', 'pipeline',
            '长篇', '详细', '完整', '学术'
        ];
        // Always treat as long query if any previous AI response was cut off
        const lastAIMsg = [...messages].reverse().find(m => m.role === 'assistant');
        const likelyCutOff = lastAIMsg && (
            /```[\w]*\n/.test(lastAIMsg.content) &&
            (lastAIMsg.content.match(/^```/gm) || []).length % 2 !== 0
        );
        return likelyCutOff || lastQuery.length > 80 || longIndicators.some(ind =>
            lastQuery.toLowerCase().includes(ind)
        );
    }

    isResponseComplete(content) {
        if (!content || content.length < 200) return true;
        const fences = (content.match(/^```/gm) || []).length;
        if (fences % 2 !== 0) return false;
        const codeSegments = content.split(/^```[\w]*/gm);
        if (codeSegments.length > 1) {
            const lastCodeBlock = codeSegments[codeSegments.length - 1] || '';
            const lastBlockLines = lastCodeBlock.split('\n').filter(l => l.trim()).length;
            if (lastBlockLines >= 150 && !/\n```\s*$/.test(content.slice(-120))) return false;
        }
        if (/\n\d+\.\s*$/.test(content) || /\n[-*]\s*$/.test(content)) return false;
        if (/\n#{1,6} [^\n]+$/.test(content.slice(-200)) && content.slice(-200).split('\n').pop().match(/^#{1,6} /)) return false;
        if (/:\s*$/.test(content.slice(-80))) return false;
        // Cut mid-identifier or mid-keyword
        if (/[a-zA-Z_]\s*$/.test(content.slice(-30))) return false;
        // Open parenthesis / bracket not closed on last line
        const lastLine = content.split('\n').pop() || '';
        const opens = (lastLine.match(/[({[]/g) || []).length;
        const closes = (lastLine.match(/[)}\]]/g) || []).length;
        if (opens > closes) return false;
        // Incomplete function/class definition
        if (/\b(def|function|class|async def|public|private|protected|static)\s+\w*\s*$/.test(content.slice(-120))) return false;
        // Trailing comma suggests more items coming
        if (/,\s*$/.test(content.slice(-40))) return false;
        // Python decorator with no following function
        if (/^\s*@\w+.*$/.test(lastLine)) return false;
        // Stub placeholder at end
        if (/^\s*#\s*(\.\.\.|\.\.\.|TODO|FIXME|rest is similar|similar to above|continues?|etc\.?)\s*$/i.test(lastLine)) return false;
        if (/^\s*pass\s*$/.test(lastLine)) return false;
        // Unmatched triple-quote (inside multiline string)
        const _tripleD = (content.match(/"""/g) || []).length;
        const _tripleS = (content.match(/'''/g) || []).length;
        if (_tripleD % 2 !== 0 || _tripleS % 2 !== 0) return false;
        // Trailing comma
        if (/,\s*$/.test(lastLine.trim()) && !lastLine.trim().startsWith('#')) return false;
        // ── Global Python completeness check ──
        const isPyScript = content.includes('#!/usr/bin/env python') || /^(?:import |from \w+ import)/m.test(content);
        if (isPyScript) {
            const hasPyMain = /if\s+__name__\s*==\s*['"]__main__['"]/m.test(content);
            if (!hasPyMain) return false;
            const topLevelDefs = (content.match(/^(?:def |async def |class )\w+/gm) || []).length;
            if (topLevelDefs < 2) return false;
        }
        const tail = content.slice(-200);
        if (isPyScript && !/if\s+__name__\s*==\s*['"]__main__['"]/m.test(content)) return false;
        return /[.!?]\s*(\n|$)/.test(tail) || /```\s*(\n|$)/.test(tail) || /\n\s*\n/.test(tail);
    }
    
    smartMerge(existing, newContent) {
        if (!existing) return newContent;
        if (!newContent || !newContent.trim()) return existing;

        let cleanNew = newContent;

        // ── Restart detection: if new content begins with shebang or same imports, it's a full restart ──
        const isFullRestart = (
            (cleanNew.includes('#!/usr/bin/env python') && existing.includes('#!/usr/bin/env python')) ||
            (cleanNew.includes('import os\n') && existing.includes('import os\n') && cleanNew.indexOf('import os') < 200)
        );
        if (isFullRestart) {
            const newLines = cleanNew.split('\n');
            // Find first line of new content that is NOT already in existing
            let divergeAt = 0;
            for (let i = 0; i < newLines.length; i++) {
                const lineChunk = newLines.slice(0, i + 5).join('\n');
                if (i > 5 && !existing.includes(lineChunk)) {
                    divergeAt = Math.max(0, i - 2); // back up 2 lines for safety
                    break;
                }
            }
            const salvaged = newLines.slice(divergeAt).join('\n');
            console.log(`[Merge] Restart detected — diverged at line ${divergeAt}, salvaged ${salvaged.length} chars`);
            cleanNew = salvaged.trim() ? salvaged : '';
            if (!cleanNew.trim()) return existing;
        }

        // ── Char-level overlap: wider window (up to 600 chars) ──
        const existingEnd = existing.slice(-600);
        let overlapFound = false;
        for (let i = Math.min(600, existingEnd.length); i >= 30; i--) {
            const possibleMatch = existingEnd.slice(-i);
            if (possibleMatch && cleanNew.startsWith(possibleMatch) && possibleMatch.length > 20) {
                cleanNew = cleanNew.slice(possibleMatch.length);
                console.log(`[Merge] Char overlap removed: ${possibleMatch.length} chars`);
                overlapFound = true;
                break;
            }
        }

        // ── Line-level overlap fallback ──
        if (!overlapFound) {
            const existingLines = existing.split('\n');
            const newLines = cleanNew.split('\n');
            for (let overlap = Math.min(12, existingLines.length, newLines.length); overlap >= 2; overlap--) {
                const existTail = existingLines.slice(-overlap).join('\n').trim();
                const newHead = newLines.slice(0, overlap).join('\n').trim();
                if (existTail && newHead && existTail === newHead && existTail.length > 10) {
                    cleanNew = newLines.slice(overlap).join('\n');
                    console.log(`[Merge] Line overlap removed: ${overlap} lines`);
                    break;
                }
            }
        }

        // ── Strip leading preamble that survived sanitize ──
        cleanNew = cleanNew.replace(/^(Continuing\.{0,3}|Here(?:'s| is) the (?:rest|continuation)[^\n]*|Sure[,!. ][^\n]{0,60}|Of course[^\n]{0,60})\n?/i, '');

        // ── Dedup: skip if cleanNew is fully contained in existing already ──
        const _hasNewDef = /^(\s*class |\s*def |\s*async def )/m.test(cleanNew);
        if (!_hasNewDef && cleanNew.trim().length < 80 && existing.includes(cleanNew.trim())) {
            console.log('[Merge] Duplicate chunk detected, skipping');
            cleanNew = '';
        }

        // ── Strip double-close fence if existing already ends with ``` ──
        if (/^```/.test(cleanNew.trimStart()) && existing.trimEnd().endsWith('```')) {
            cleanNew = cleanNew.replace(/^```[^\n]*\n?/, '').trimStart();
        }

        if (!cleanNew.trim()) return existing;

        const existingFenceCount = (existing.match(/^```/gm) || []).length;
        const insideOpenFence = existingFenceCount % 2 !== 0;
        const separator = insideOpenFence ? '\n' : '\n\n';
        const merged = existing + separator + cleanNew;

        // Final fence repair
        const fenceCount = (merged.match(/^```/gm) || []).length;
        if (fenceCount % 2 !== 0) return merged.trimEnd() + '\n```';
        return merged;
    }
    
    // Find buildContinuationPrompt in SmartContinuationManager:
    buildContinuationPrompt(fullResponse, originalQuery = '') {
        const lines = fullResponse.split('\n');
        const lastLines = lines.slice(-35).join('\n');
        const openFences = (fullResponse.match(/^```/gm) || []).length;
        const insideCodeBlock = openFences % 2 !== 0;
        const lastChar = fullResponse.trimEnd().slice(-1);
        const lastNonEmpty = lines.slice().reverse().find(l => l.trim()) || '';
        const cutMidWord = lastChar && !/[\s.!?:,;)\]}`'"]/.test(lastChar);
        // Detect what class/function was being written at cut point
        const lastClassMatch = [...fullResponse.matchAll(/^class (\w+)/gm)].pop();
        const lastFnMatch = [...fullResponse.matchAll(/^\s{0,8}(?:async )?def (\w+)/gm)].pop();
        const lastClass = lastClassMatch?.[1] || '';
        const lastFn = lastFnMatch?.[1] || '';
        const isCode = /```[\w]/.test(fullResponse) || /^(class |def |import |from |async def )/m.test(fullResponse);
        const totalLines = lines.length;
        const hasStub = /^\s*#\s*(\.\.\.|\.\.\.|TODO|FIXME|rest is similar|similar to above|continues?|etc\.?)\s*$/i.test(lastNonEmpty)
                     || /^\s*pass\s*$/.test(lastNonEmpty);

        const fenceHint = insideCodeBlock
            ? '\n⚠️  You stopped INSIDE an open code block. Resume the code IMMEDIATELY on the very next line — do NOT emit ``` before the continuation, do NOT close and reopen the block.'
            : '';
        const codeHint = isCode
            ? '\n⚠️  CODE FILE: Write ALL remaining functions/classes/methods in FULL. NEVER use "# ... rest is similar", "# similar to above", "# TODO", or "pass" as a placeholder. Every function body must be completely implemented.'
            : '';
        const wordHint = cutMidWord
            ? `\n⚠️  The last character "${lastChar}" is cut mid-word/token. Complete that word first, then continue normally.`
            : '';
        const lineHint = totalLines > 80
            ? `\n⚠️  HARD TRUNCATION at ~${totalLines} lines. Continue from the EXACT last character. Do NOT restart from the beginning, do NOT repeat imports, class name, or any prior code.`
            : '';
        const stubHint = hasStub
            ? '\n⚠️  The previous output ended with a stub/placeholder (# ... or pass). Replace it with a COMPLETE implementation — do not repeat the stub, write the actual code.'
            : '';
        const antiRestartHint = '\n⚠️  DO NOT start fresh. DO NOT write "#!/usr/bin/env python3" or any imports you already wrote. Begin from the exact next character after the cut.';
        const taskHint = originalQuery
            ? `\n📋 ORIGINAL TASK (write ALL of it — do not stop early): ${originalQuery.slice(0, 300)}`
            : '';
        const positionHint = (lastClass || lastFn)
            ? `\n📍 Cut point: inside ${lastClass ? `class ${lastClass}` : ''}${lastFn ? ` → def ${lastFn}` : ''}. Complete this function/class FULLY, then write all remaining code.`
            : '';

        return `Continue writing from the exact point where the previous output ended. Output ONLY the continuation — no preamble, no "Continuing...", no "Here is the rest:", no repetition of anything above.${fenceHint}${codeHint}${wordHint}${lineHint}${stubHint}${antiRestartHint}${taskHint}${positionHint}

=== END OF PREVIOUS OUTPUT (last 35 lines — do NOT repeat any of this) ===
${lastLines}
=== WRITE THE CONTINUATION STARTING FROM THE VERY NEXT CHARACTER — NO PREAMBLE ===`;
    }
    async parallelContinuation(keyObj, fullResponse, originalMessages, originalQuery = '') {
        const lines = fullResponse.split('\n');
        const openFences = (fullResponse.match(/^```/gm) || []).length;
        const insideCodeBlock = openFences % 2 !== 0;
        const totalLines = lines.length;
        // Inherit originalQuery from session if not passed
        const taskQuery = originalQuery || originalMessages[originalMessages.length - 1]?.content || '';
        const existingTail = fullResponse.slice(-600);
        const lastNonEmpty = lines.slice().reverse().find(l => l.trim()) || '';
        const hasStub = /^\s*#\s*(\.\.\.|\.\.\.|TODO|rest is similar|similar to above|etc\.?)\s*$/i.test(lastNonEmpty)
                     || /^\s*pass\s*$/.test(lastNonEmpty);

        // Detect last class/function written so we can name it in the prompt
        const lastClassMatch = [...fullResponse.matchAll(/^class (\w+)/gm)].pop();
        const lastFnMatch = [...fullResponse.matchAll(/^\s{0,8}(?:async )?def (\w+)/gm)].pop();
        const lastClass = lastClassMatch?.[1] || '';
        const lastFn = lastFnMatch?.[1] || '';
        const posHint = (lastClass || lastFn)
            ? `\n📍 Cut at: ${lastClass ? `class ${lastClass}` : ''}${lastFn ? ` → def ${lastFn}` : ''}. Complete this and ALL remaining code.`
            : '';

        const fenceHint = insideCodeBlock
            ? '\n⚠️ INSIDE open code block — DO NOT emit ``` header. Resume code directly.'
            : '';
        const stubHint = hasStub
            ? '\n⚠️ Ended with placeholder/stub. Write the COMPLETE implementation now.'
            : '';
        const antiRestart = '\n⚠️ DO NOT restart from the top. DO NOT repeat shebang, imports, or class headers already written.';
        const taskHint = taskQuery
            ? `\n📋 FULL TASK (complete everything): ${taskQuery.slice(0, 400)}`
            : '';

        const sysMsg = 'You are an AI completing a truncated Python script. Output ONLY the continuation — no preamble, no "Continuing...", no repeated code.';

        // Strategy A: tail-based (short/medium/long context) — find exact splice point
        const makeTailMsg = (contextLines, assistantChars) => {
            const tail = lines.slice(-contextLines).join('\n');
            return [
                { role: 'system', content: sysMsg },
                { role: 'user', content: taskQuery },
                { role: 'assistant', content: fullResponse.slice(-assistantChars) },
                { role: 'user', content: `Continue from the exact cut-off point.${fenceHint}${stubHint}${antiRestart}${posHint}\n⚠️ Truncated at ~${totalLines} lines.\n\n=== LAST ${contextLines} LINES (do NOT repeat) ===\n${tail}\n=== CONTINUE FROM VERY NEXT CHARACTER ===` }
            ];
        };

        // Analyze what's been written and what's still missing
        const writtenClasses = [...fullResponse.matchAll(/^class (\w+)/gm)].map(m => m[1]);
        const writtenDefs = [...fullResponse.matchAll(/^\s*def (\w+)/gm)].map(m => m[1]);
        const hasMainEntry = /if\s+__name__\s*==\s*['"]__main__['"]/m.test(fullResponse);
        const hasArgparse = /argparse/i.test(fullResponse);
        const hasCLI = /def main\b/m.test(fullResponse);

        const missingList = [];
        if (!hasCLI) missingList.push('main() function');
        if (!hasMainEntry) missingList.push('if __name__ == "__main__": entry point');
        if (!hasArgparse) missingList.push('argparse CLI argument handling');
        if (writtenClasses.length > 0 && writtenDefs.filter(d => d === 'export_results' || d === 'save' || d === 'export').length === 0) {
            missingList.push('export/save results function');
        }
        const missingStr = missingList.length > 0
            ? `\nSTILL MISSING: ${missingList.join(', ')}.`
            : '';

        // Strategy B: guided-completion — tell the AI what's still missing
        const makeGuidedMsg = () => {
            const tail = lines.slice(-20).join('\n');
            return [
                { role: 'system', content: 'You are a Python expert completing an unfinished script. Write ONLY the missing remainder.' },
                { role: 'user', content: `TASK: ${taskQuery}\n\nThe script was cut off partway through. Here is the last portion that was written:\n\n${tail}\n\nWrite ALL the remaining code that is needed to complete the task fully — every function, class method, CLI handler, and main() block. Output only code, no preamble.${antiRestart}${posHint}${missingStr}` }
            ];
        };

        // Strategy C: section-by-section — explicitly request the next missing section
        const makeNextSectionMsg = () => {
            const tail = lines.slice(-15).join('\n');
            const nextMissing = missingList[0] || 'remaining code';
            return [
                { role: 'system', content: 'You are completing a Python script. Write ONLY the next missing section.' },
                { role: 'user', content: `TASK: ${taskQuery}\n\nAlready written: ${writtenClasses.length} classes (${writtenClasses.join(', ')}), ${writtenDefs.length} methods.\n\nNEXT TO WRITE: ${nextMissing}${missingStr}\n\nLast lines written:\n${tail}\n\nWrite the ${nextMissing} now. Output ONLY Python code, no preamble, no markdown fences if already inside a code block.${posHint}` }
            ];
        };

        // 10 calls: 6 tail-based + 2 guided + 2 section-by-section
        const callParams = [
            [15, 1500],
            [25, 2500],
            [40, 3500],
            [50, 5000],
            [12, 1200],
            [30, 3000]
        ];
        const calls = [
            ...callParams.map(([ctx, chars]) =>
                callAPI(keyObj, makeTailMsg(ctx, chars), 14000).catch(() => null)
            ),
            callAPI(keyObj, makeGuidedMsg(), 16000).catch(() => null),
            callAPI(keyObj, makeGuidedMsg(), 16000).catch(() => null),
            callAPI(keyObj, makeNextSectionMsg(), 16000).catch(() => null),
            callAPI(keyObj, makeNextSectionMsg(), 16000).catch(() => null)
        ];

        console.log('[Parallel] Firing 10 simultaneous Blackbox continuation calls (6 tail + 2 guided + 2 section)...');
        const settled = await Promise.allSettled(calls);

        let best = '';
        let bestNewLen = 0;
        const candidates = [];

        for (const r of settled) {
            if (r.status !== 'fulfilled' || !r.value) continue;
            let c = sanitizeBlackboxResponse(r.value?.choices?.[0]?.message?.content || '');
            if (!c || c.trim().length < 10) continue;

            // Strip overlap with tail (up to 600 chars)
            for (let ol = Math.min(600, existingTail.length); ol >= 20; ol--) {
                if (c.startsWith(existingTail.slice(-ol))) { c = c.slice(ol); break; }
            }
            // Strip preamble survivors
            c = c.replace(/^(Continuing\.{0,3}|Here(?:'s| is) the (?:rest|continuation)[^\n]*|Sure[,!. ][^\n]{0,60}|Of course[^\n]{0,60})\n?/i, '');
            // Penalize full restarts
            const isRestart = c.includes('#!/usr/bin/env python') && fullResponse.includes('#!/usr/bin/env python');
            const newLen = isRestart ? 0 : c.replace(/\s/g, '').length;

            candidates.push({ c, newLen });
            if (newLen > bestNewLen) { bestNewLen = newLen; best = c; }
        }

        // Prefer a candidate that has MORE unique def/class signatures than current best
        for (const cand of candidates) {
            if (cand.newLen < 50) continue;
            const candFns = (cand.c.match(/^\s*(?:async )?def \w+/gm) || []);
            const bestFns = (best.match(/^\s*(?:async )?def \w+/gm) || []);
            const uniqueToCanд = candFns.filter(fn => !best.includes(fn));
            if (uniqueToCanд.length > 0 && cand.newLen > bestNewLen * 0.7) {
                best = cand.c; bestNewLen = cand.newLen;
            }
        }

        console.log(`[Parallel] Best of ${candidates.length}/${settled.length}: ${best.length} chars, ${bestNewLen} new non-ws chars`);
        return best || null;
    }
    
    async callAPIWithRetry(keyObj, messages, maxTokens, retries = 2) {
        for (let i = 0; i <= retries; i++) {
            try {
                const data = await callAPI(keyObj, messages, maxTokens);
                const content = data?.choices?.[0]?.message?.content;
                if (!content && i < retries) {
                    console.log(`[Retry ${i + 1}] Empty content, retrying...`);
                    await this.delay(800);
                    continue;
                }
                return data;
            } catch (e) {
                console.log(`[Retry ${i + 1}/${retries}] Error: ${e.message}`);
                if (i === retries) throw e;
                await this.delay(1000 * (i + 1));
            }
        }
    }
    
    delay(ms) { return new Promise(r => setTimeout(r, ms)); }
}

/**
 * Parse subtitle file content based on format
 * Supports: SRT, VTT, JSON3, TTML
 */
/**
 * Parse timestamp in various formats to seconds
 */
function parseTimestamp(ts) {
    // Handle HH:MM:SS.mmm or MM:SS.mmm or SS.mmm
    const parts = ts.split(':');
    if (parts.length === 3) {
        return parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]);
    } else if (parts.length === 2) {
        return parseFloat(parts[0]) * 60 + parseFloat(parts[1]);
    }
    return parseFloat(ts) || 0;
}
function _decodeCaptionText(value) {
    return String(value || '')
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&#39;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/\n/g, ' ')
        .trim();
}

function _buildTimedCaptionWords(segments, captionStart, captionDur) {
    const words = [];

    segments.forEach(segment => {
        const text = _decodeCaptionText(segment.text);
        const parts = text.split(/\s+/).filter(Boolean);

        if (!parts.length) return;

        const segmentStart =
            captionStart + Number(segment.offset || 0);

        const segmentDur = Math.max(
            0.05,
            Number(segment.dur || 0) || captionDur
        );

        const totalCharacters = parts.reduce(
            (sum, part) => sum + Math.max(1, part.length),
            0
        );

        let consumedCharacters = 0;

        parts.forEach(part => {
            const partStart = segmentStart +
                segmentDur *
                (consumedCharacters / totalCharacters);

            consumedCharacters += Math.max(1, part.length);

            const partEnd = segmentStart +
                segmentDur *
                (consumedCharacters / totalCharacters);

            words.push({
                text: part,
                start: partStart,
                end: Math.max(partStart + 0.04, partEnd)
            });
        });
    });

    return words;
}

function parseSubtitleFile(content, format) {
    const captions = [];
    
    switch (format.toLowerCase()) {
        case 'srt':
            // SRT format: 00:00:01,000 --> 00:00:04,000
            const srtBlocks = content.split(/\n\n+/);
            for (const block of srtBlocks) {
                const lines = block.trim().split('\n');
                if (lines.length < 2) continue;
                
                const timeMatch = lines[1]?.match(
                    /(\d{2}):(\d{2}):(\d{2})[.,](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[.,](\d{3})/
                );
                if (!timeMatch) continue;
                
                const startH = parseInt(timeMatch[1]), startM = parseInt(timeMatch[2]);
                const startS = parseInt(timeMatch[3]), startMs = parseInt(timeMatch[4]);
                const endH = parseInt(timeMatch[5]), endM = parseInt(timeMatch[6]);
                const endS = parseInt(timeMatch[7]), endMs = parseInt(timeMatch[8]);
                
                const start = startH * 3600 + startM * 60 + startS + startMs / 1000;
                const end = endH * 3600 + endM * 60 + endS + endMs / 1000;
                const text = lines.slice(2).join(' ').trim()
                    .replace(/<[^>]+>/g, '')  // Remove HTML tags
                    .replace(/&amp;/g, '&')
                    .replace(/&lt;/g, '<')
                    .replace(/&gt;/g, '>')
                    .replace(/&quot;/g, '"')
                    .replace(/&#39;/g, "'");
                
                if (text) {
                    captions.push({ text, start, dur: end - start });
                }
            }
            break;
            
        case 'vtt':
        case 'webvtt':
            const vttLines = content.split('\n');
            let currentStart = 0;
            let currentEnd = 0;
            let currentText = '';

            for (let i = 0; i < vttLines.length; i++) {
                const line = vttLines[i].trim();

                const timeMatch = line.match(
                    /(\d{2}):(\d{2}):(\d{2})[.,](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[.,](\d{3})/
                );

                if (timeMatch) {
                    if (currentText.trim()) {
                        captions.push({
                            text: currentText.trim(),
                            start: currentStart,
                            dur: Math.max(0.05, currentEnd - currentStart)
                        });
                    }

                    currentStart =
                        parseInt(timeMatch[1], 10) * 3600 +
                        parseInt(timeMatch[2], 10) * 60 +
                        parseInt(timeMatch[3], 10) +
                        parseInt(timeMatch[4], 10) / 1000;

                    currentEnd =
                        parseInt(timeMatch[5], 10) * 3600 +
                        parseInt(timeMatch[6], 10) * 60 +
                        parseInt(timeMatch[7], 10) +
                        parseInt(timeMatch[8], 10) / 1000;

                    currentText = '';
                } else if (
                    line &&
                    !line.startsWith('WEBVTT') &&
                    !line.startsWith('Kind:') &&
                    !line.startsWith('Language:') &&
                    !line.match(/^\d+$/) &&
                    !line.startsWith('NOTE')
                ) {
                    currentText += (currentText ? ' ' : '') + line
                        .replace(/<[^>]+>/g, '')
                        .replace(/&amp;/g, '&')
                        .replace(/&lt;/g, '<')
                        .replace(/&gt;/g, '>');
                }
            }

            if (currentText.trim()) {
                captions.push({
                    text: currentText.trim(),
                    start: currentStart,
                    dur: Math.max(0.05, currentEnd - currentStart)
                });
            }
            break;
            
        case 'json':
        case 'json3':
            // YouTube JSON3 format
            try {
                const data = JSON.parse(content);
                if (data.events) {
                    for (const event of data.events) {
                        if (event.segs && event.segs.length > 0) {
                            const text = event.segs
                                .map(seg => seg.utf8 || '')
                                .join(' ')
                                .trim();
                            if (text) {
                                const captionStart =
                                    (event.tStartMs || 0) / 1000;
                                const captionDur =
                                    (event.dDurationMs || 3000) / 1000;
                                captions.push({
                                    text,
                                    start: captionStart,
                                    dur: captionDur,
                                    words: _buildTimedCaptionWords(
                                        event.segs.map(seg => ({
                                            text: seg.utf8 || '',
                                            offset: Number(seg.t || 0) / 1000,
                                            dur: Number(seg.d || 0) / 1000
                                        })),
                                        captionStart,
                                        captionDur
                                    )
                                });
                            }
                        }
                    }
                }
            } catch (e) {}
            break;
            
        case 'ttml':
            // Basic TTML extraction
            const ttmlRegex = /<p[^>]*begin="([^"]*)"[^>]*end="([^"]*)"[^>]*>(.*?)<\/p>/g;
            let match;
            while ((match = ttmlRegex.exec(content)) !== null) {
                const text = match[3]
                    .replace(/<[^>]+>/g, '')
                    .replace(/&amp;/g, '&')
                    .replace(/&lt;/g, '<')
                    .replace(/&gt;/g, '>')
                    .trim();
                if (text) {
                    captions.push({
                        text: text,
                        start: parseTimestamp(match[1]),
                        dur: parseTimestamp(match[2]) - parseTimestamp(match[1])
                    });
                }
            }
            break;
    }
    
    return captions.filter(c => c.text.length > 0);
}

// ─── PERMANENT CODE SANITIZER ──────────────────────────────────────────────
const MPL_RUNNER = [
    'import sys, os, traceback',
    'import matplotlib',
    "matplotlib.use('Agg')",
    'import matplotlib.pyplot as plt',
    'out, path = sys.argv[1], sys.argv[2]',
    'count = [0]',
    'def save_figs(*args, **kwargs):',
    '    for num in plt.get_fignums():',
    '        count[0] += 1',
    "        plt.figure(num).savefig(os.path.join(out, 'fig_%02d.png' % count[0]), dpi=110, bbox_inches='tight')",
    "    plt.close('all')",
    'plt.show = save_figs',
    "scope = {'__name__': '__main__', '__file__': path}",
    'try:',
    "    with open(path, encoding='utf-8') as fh:",
    '        source = fh.read()',
    "    exec(compile(source, path, 'exec'), scope)",
    'except SystemExit:',
    '    pass',
    'except BaseException:',
    '    et, ev, tb = sys.exc_info()',
    '    traceback.print_exception(et, ev, tb.tb_next)',
    '    save_figs()',
    '    sys.exit(1)',
    'save_figs()'
].join('\n');

function sanitizeCodeForExecution(code, language) {
    if (!code || typeof code !== 'string') return code;
    let out = code.trim();

    // ── JAVA ──────────────────────────────────────────────────────────────
    if (language === 'java') {
        // 1. Strip markdown fences (```java ... ```)
        out = out.replace(/^```[a-zA-Z]*\n?/gm, '').replace(/^```$/gm, '').trim();

        // 2. Collect all public class declarations
        const pubClasses = [...out.matchAll(/public\s+class\s+(\w+)/g)];

        if (pubClasses.length === 1) {
            const name = pubClasses[0][1];
            if (name !== 'Main') {
                out = out.replace(new RegExp(`\\b${name}\\b`, 'g'), 'Main');
            }
        } else if (pubClasses.length > 1) {
            // Find the class that holds public static void main
            const winner = pubClasses.find(m => {
                const snippet = out.slice(m.index, m.index + 3000);
                return /public\s+static\s+void\s+main/.test(snippet);
            }) || pubClasses[0];
            const keepName = winner[1];

            // Demote all other public classes
            out = out.replace(/public\s+class\s+(\w+)/g,
                (match, n) => n === keepName ? match : `class ${n}`
            );

            // Rename winner to Main
            if (keepName !== 'Main') {
                out = out.replace(new RegExp(`\\b${keepName}\\b`, 'g'), 'Main');
            }
        } else if (pubClasses.length === 0) {
            // No public class at all — wrap entire code in Main if it has a main method
            if (/static\s+void\s+main/.test(out)) {
                out = `public class Main {\n${out}\n}`;
            } else {
                // Assume it's a bare main body
                out = `public class Main {\n    public static void main(String[] args) {\n${out}\n    }\n}`;
            }
        }

        // 3. Ensure no duplicate class declarations
        const seen = new Set();
        out = out.replace(/\b(class)\s+(\w+)/g, (match, keyword, name) => {
            if (seen.has(name)) return `/* duplicate:${name} */ class _Dup${name}`;
            seen.add(name);
            return match;
        });
    }

    // ── PYTHON ────────────────────────────────────────────────────────────
    if (language === 'python') {
        // 1. Strip markdown fences
        out = out.replace(/^```[a-zA-Z]*\n?/gm, '').replace(/^```$/gm, '').trim();

        // 2. Normalize Windows line endings
        out = out.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

        // 3. Remove BOM if present
        out = out.replace(/^\uFEFF/, '');

        // 4. Fix common smart-quote issues from model output
        out = out.replace(/['']/g, "'").replace(/[""]/g, '"');

        // 5. Fix hljs Python corruption: "FileHubandler" → "FileHandler", "select_all" → "select"
        out = out.replace(/\bFile(Hub|Hub)andler\b/g, 'FileHandler');
        out = out.replace(/\blogging\.File(Hub|Hub)andler\b/g, 'logging.FileHandler');
        out = out.replace(/\.select_all\s*\(/g, '.select(');
        out = out.replace(/\bHubandler\b/g, 'Handler');
    }

    // ── BOTH ──────────────────────────────────────────────────────────────
    // Remove null bytes that break file writes
    out = out.replace(/\0/g, '');

    return out;
}
// ──────────────────────────────────────────────────────────────────────────

const continuationManager = new SmartContinuationManager();
function parseDictionaryData(dictData) {
    const definitions = [];
    const synonyms = new Set();
    const antonyms = new Set();

    (dictData.meanings || []).forEach(meaning => {
        (meaning.definitions || []).slice(0, 3).forEach(def => {
            definitions.push({
                pos: meaning.partOfSpeech,
                def: def.definition,
                example: def.example || ''
            });
            (def.synonyms || []).forEach(s => synonyms.add(s));
            (def.antonyms || []).forEach(a => antonyms.add(a));
        });
        (meaning.synonyms || []).forEach(s => synonyms.add(s));
        (meaning.antonyms || []).forEach(a => antonyms.add(a));
    });

    const audioUrl = (dictData.phonetics || []).find(p => p.audio)?.audio || null;

    return {
        word: dictData.word,
        phonetic: dictData.phonetic || dictData.phonetics?.[0]?.text || '',
        audio: audioUrl ? (audioUrl.startsWith('http') ? audioUrl : 'https:' + audioUrl) : null,
        origin: dictData.origin || '',
        partOfSpeech: [...new Set((dictData.meanings || []).map(m => m.partOfSpeech))],
        synonyms: [...synonyms].slice(0, 8),
        antonyms: [...antonyms].slice(0, 5),
        definitions: definitions.slice(0, 6),
        collocations: [],
        register: 'neutral',
        difficulty: 'B1'
    };
}

// Inject client code or save as separate file
console.log('Unified Response Manager ready - Font controls + Auto-continuation active');

const PORT = parseInt(process.env.PORT || '8080');

let requestCount = 0;
let errorCount = 0;

// ═══════════════════════════════════════════════════════
// DIAGRAM GENERATOR — Python writes SVG, deleted after use
// ═══════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════
// ROADMAP LAYOUT ENGINE — server-side geometry, no LLM guessing
// ═══════════════════════════════════════════════════════════════

/**
 * Parse roadmap skill data from an LLM response.
 * The LLM returns ONLY content (names, groups, times) — no coordinates.
 * We compute all positions here.
 */
function parseRoadmapSkills(rawJson) {
    try {
        const data = typeof rawJson === 'string' ? JSON.parse(rawJson) : rawJson;
        return {
            title:    data.title    || 'Learning Roadmap',
            subtitle: data.subtitle || '',
            sections: (data.sections || []).map(sec => ({
                label:    sec.label    || 'Section',
                color:    sec.color    || '#6366f1',
                textColor:sec.textColor|| '#fff',
                skills:  (sec.skills || []).map(sk => ({
                    name:     sk.name     || '',
                    time:     sk.time     || '',
                    optional: sk.optional || false,
                    type:     sk.type     || 'normal'  // normal | milestone | warn
                }))
            }))
        };
    } catch(e) {
        return null;
    }
}

/**
 * Measure text width conservatively (no DOM access on server).
 * Uses character-width lookup calibrated to Arial/sans-serif 13px.
 */
function measureText(str, fontSize = 13, bold = false) {
    if (!str) return 0;
    const NARROW = /[ijl!|'.,;: \t]/g;
    const WIDE   = /[mwMW]/g;
    const narrow = (str.match(NARROW) || []).length;
    const wide   = (str.match(WIDE)   || []).length;
    const normal = str.length - narrow - wide;
    const scale  = bold ? 1.1 : 1.0;
    const base   = (narrow * 4 + normal * 7.5 + wide * 11) * (fontSize / 13) * scale;
    return Math.ceil(base);
}

/**
 * Wrap text into lines that fit within maxWidth.
 * Returns array of strings (one per line).
 */
function wrapText(text, maxWidth, fontSize = 13, bold = false) {
    if (!text) return [''];
    const words = text.split(/\s+/);
    const lines = [];
    let current = '';
    for (const word of words) {
        const test = current ? current + ' ' + word : word;
        if (measureText(test, fontSize, bold) <= maxWidth) {
            current = test;
        } else {
            if (current) lines.push(current);
            current = word;
        }
    }
    if (current) lines.push(current);
    return lines.length ? lines : [''];
}

/**
 * Core layout function.
 * Produces a complete, self-contained SVG string.
 *
 * Layout strategy (roadmap.sh-style):
 *  - Each section = a labelled "swim lane"
 *  - Skills flow top-to-bottom inside each lane
 *  - Connector lines enter/exit from box edges ONLY
 *  - No line passes through any box interior
 *  - All text is guaranteed to fit inside its box
 */
function buildRoadmapSVG(roadmap) {
    if (!roadmap || !roadmap.sections || roadmap.sections.length === 0) {
        return buildFallbackSVG(roadmap?.title || 'Roadmap');
    }

    // ── Layout constants ──────────────────────────────────────
    const SVG_W          = 820;   // total SVG width
    const MARGIN_X       = 28;    // left/right outer margin
    const TITLE_H        = 70;    // space for title block
    const SEC_LABEL_H    = 32;    // section header height
    const SEC_PAD_TOP    = 14;    // padding inside section, above first box
    const SEC_PAD_BOT    = 18;    // padding inside section, below last box
    const SEC_GAP        = 24;    // vertical gap between sections
    const BOX_PAD_X      = 18;    // horizontal padding inside skill box
    const BOX_PAD_Y      = 12;    // vertical padding inside skill box
    const BOX_MIN_W      = 180;
    const BOX_MAX_W      = 280;
    const BOX_GAP_X      = 16;    // gap between boxes in same row
    const BOX_GAP_Y      = 14;    // gap between rows
    const CONNECTOR_W    = 2;     // stroke width of connector line
    const LINE_H_MAIN    = 18;    // line-height for main name text
    const LINE_H_SUB     = 14;    // line-height for sub (time) text
    const FONT_MAIN      = 14;
    const FONT_SUB       = 11;
    const ROW_COLS       = 3;     // max boxes per row in a section

    // ── Step 1: Pre-compute box sizes ─────────────────────────
    const processedSections = roadmap.sections.map(sec => {
        const boxes = sec.skills.map(sk => {
            const nameLines = wrapText(sk.name, BOX_MAX_W - BOX_PAD_X * 2, FONT_MAIN, true);
            const timeLines = sk.time
                ? wrapText(sk.time, BOX_MAX_W - BOX_PAD_X * 2, FONT_SUB, false)
                : [];
            const textW = Math.max(
                ...nameLines.map(l => measureText(l, FONT_MAIN, true)),
                ...timeLines.map(l => measureText(l, FONT_SUB, false))
            );
            const boxW = Math.min(BOX_MAX_W,
                         Math.max(BOX_MIN_W, textW + BOX_PAD_X * 2));
            
            const milestoneExtra = (sk.type === 'milestone') ? 8 : 0;
            const boxH = BOX_PAD_Y * 2
                       + nameLines.length * LINE_H_MAIN
                       + (timeLines.length ? 6 + timeLines.length * LINE_H_SUB : 0)
                       + milestoneExtra
                       + 4;   // bottom breathing room
            return { ...sk, nameLines, timeLines, boxW, boxH };
        });
        return { ...sec, boxes };
    });

    // ── Step 2: Assign rows & columns, compute section heights ─
    const USABLE_W = SVG_W - MARGIN_X * 2;

    processedSections.forEach(sec => {
        const rows = [];
        let i = 0;
        while (i < sec.boxes.length) {
            const row = [];
            let rowW = 0;
            while (i < sec.boxes.length && row.length < ROW_COLS) {
                const b = sec.boxes[i];
                const needed = rowW + (row.length ? BOX_GAP_X : 0) + b.boxW;
                if (needed > USABLE_W && row.length > 0) break;
                row.push(b);
                rowW += (row.length > 1 ? BOX_GAP_X : 0) + b.boxW;
                i++;
            }
            rows.push(row);
        }
        sec.rows = rows;
        const maxRowH = rows.map(row => Math.max(...row.map(b => b.boxH)));
        sec.sectionH = SEC_LABEL_H
                     + SEC_PAD_TOP
                     + maxRowH.reduce((s, h) => s + h, 0)
                     + Math.max(0, rows.length - 1) * BOX_GAP_Y
                     + SEC_PAD_BOT;
        sec.rowHeights = maxRowH;
    });

    // ── Step 3: Assign absolute y positions ───────────────────
    let curY = TITLE_H;
    processedSections.forEach(sec => {
        sec.sectionY = curY;
        curY += sec.sectionH + SEC_GAP;
    });
    const SVG_H = curY + 20;

    // ── Step 4: Render SVG ────────────────────────────────────
    const lines = [];
    lines.push(`<svg width="100%" viewBox="0 0 ${SVG_W} ${SVG_H}" xmlns="http://www.w3.org/2000/svg" font-family="Arial,Helvetica,sans-serif">`);

    // Background
    lines.push(`<rect width="${SVG_W}" height="${SVG_H}" fill="#ffffff"/>`);

    // Title
    lines.push(`<text x="${SVG_W/2}" y="34" text-anchor="middle"
        font-size="22" font-weight="700" fill="#1e1e2e">${escapeXML(roadmap.title)}</text>`);
    if (roadmap.subtitle) {
        lines.push(`<text x="${SVG_W/2}" y="56" text-anchor="middle"
            font-size="13" fill="#64748b">${escapeXML(roadmap.subtitle)}</text>`);
    }

    // Arrow marker — connects ONLY at box edges
    lines.push(`<defs>
        <marker id="rm-arrow" viewBox="0 0 6 6" refX="5" refY="3"
            markerWidth="4" markerHeight="4" orient="auto-start-reverse">
            <polyline points="0,1 4,3 0,5" fill="none" stroke="#94a3b8"
                stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
        </marker>
    </defs>`);

    // ── Render sections ───────────────────────────────────────
    processedSections.forEach(sec => {
        const sy = sec.sectionY;

        // Section background panel
        lines.push(`<rect x="${MARGIN_X}" y="${sy}"
            width="${USABLE_W}" height="${sec.sectionH}"
            rx="10" fill="${sec.color}1a" stroke="${sec.color}40" stroke-width="1.2"/>`);

        // Section label (left-aligned inside panel)
        lines.push(`<text x="${MARGIN_X + 14}" y="${sy + 21}"
            font-size="13" font-weight="700"
            fill="${sec.color}" letter-spacing="0.5">${escapeXML(sec.label.toUpperCase())}</text>`);

        // ── Render rows ──────────────────────────────────────
        let rowY = sy + SEC_LABEL_H + SEC_PAD_TOP;

        // Track centre-bottom of every box for connectors
        // Key: `r,c` → { cx, bottomY, topY }
        const boxPositions = [];

        sec.rows.forEach((row, ri) => {
            const rowH = sec.rowHeights[ri];

            // Centre the row horizontally in the usable width
            const totalRowW = row.reduce((s, b) => s + b.boxW, 0)
                            + Math.max(0, row.length - 1) * BOX_GAP_X;
            let bx = MARGIN_X + Math.round((USABLE_W - totalRowW) / 2);

            row.forEach((box, ci) => {
                const by = rowY;

                // Render box
                const fill   = box.optional ? '#f8fafc' : '#ffffff';
                const stroke = box.optional ? '#cbd5e1' : sec.color;
                const sw     = box.optional ? 1 : 1.8;
                const dash   = box.optional ? 'stroke-dasharray="4 3"' : '';

                lines.push(`<rect x="${bx}" y="${by}"
                    width="${box.boxW}" height="${box.boxH}"
                    rx="7" fill="${fill}" stroke="${stroke}"
                    stroke-width="${sw}" ${dash}/>`);

                // Optional badge
                if (box.optional) {
                    const badgeX = bx + box.boxW - 6;
                    const badgeY = by + 6;
                    lines.push(`<rect x="${badgeX - 36}" y="${badgeY}"
                        width="36" height="14" rx="7"
                        fill="#e2e8f0"/>`);
                    lines.push(`<text x="${badgeX - 18}" y="${badgeY + 10}"
                        text-anchor="middle" font-size="9" fill="#64748b">optional</text>`);
                }

                // Milestone diamond marker
                if (box.type === 'milestone') {
                    lines.push(`<text x="${bx + 9}" y="${by + 14}"
                        font-size="13" fill="${sec.color}">◆</text>`);
                }

                // ── Name (bold, wraps, dark color) ──
                const nameX = bx + box.boxW / 2;
                const totalTextH = box.nameLines.length * LINE_H_MAIN
                                 + (box.timeLines.length ? 6 + box.timeLines.length * LINE_H_SUB : 0);
                let textY = by + BOX_PAD_Y + LINE_H_MAIN;

                box.nameLines.forEach((line, li) => {
                    // Bold main text
                    lines.push(`<text x="${nameX}" y="${textY}"
                        text-anchor="middle"
                        font-size="${FONT_MAIN}"
                        font-weight="700"
                        font-family="Arial,sans-serif"
                        fill="#1e293b">${escapeXML(line)}</text>`);
                    // Subtle underline accent under the first name line only
                    if (li === 0 && box.nameLines.length === 1) {
                        const tw = Math.min(box.boxW - BOX_PAD_X * 2,
                                            measureText(line, FONT_MAIN, true));
                        const lx = bx + (box.boxW - tw) / 2;
                        lines.push(`<line x1="${lx}" y1="${textY + 3}"
                            x2="${lx + tw}" y2="${textY + 3}"
                            stroke="${sec.color}55" stroke-width="1.5"/>`);
                    }
                    textY += LINE_H_MAIN;
                });

                // ── Time subtitle (italic, lighter color) ──
                if (box.timeLines.length) {
                    textY += 4;
                    box.timeLines.forEach(line => {
                        // Small clock icon rendered as text glyph before time
                        lines.push(`<text x="${nameX}" y="${textY}"
                            text-anchor="middle"
                            font-size="${FONT_SUB}"
                            font-style="italic"
                            font-family="Arial,sans-serif"
                            fill="#64748b">⏱ ${escapeXML(line)}</text>`);
                        textY += LINE_H_SUB;
                    });
                }

                // ── Keyword pill (milestone type gets a colored badge) ──
                if (box.type === 'milestone') {
                    const pillW = 56, pillH = 14;
                    const pillX = bx + box.boxW - pillW - 6;
                    const pillY = by + 5;
                    lines.push(`<rect x="${pillX}" y="${pillY}"
                        width="${pillW}" height="${pillH}" rx="7"
                        fill="${sec.color}22" stroke="${sec.color}66" stroke-width="1"/>`);
                    lines.push(`<text x="${pillX + pillW/2}" y="${pillY + 10}"
                        text-anchor="middle"
                        font-size="9" font-weight="700"
                        font-family="Arial,sans-serif"
                        fill="${sec.color}">MILESTONE</text>`);
                }

                // ── Warning badge ──
                if (box.type === 'warn') {
                    lines.push(`<text x="${bx + 10}" y="${by + 14}"
                        font-size="13" fill="#f59e0b">⚠</text>`);
                }
                // Store positions for connector routing
                boxPositions.push({
                    ri, ci,
                    cx:     bx + box.boxW / 2,
                    topY:   by,
                    bottomY:by + box.boxH,
                    leftX:  bx,
                    rightX: bx + box.boxW,
                    midY:   by + box.boxH / 2
                });

                bx += box.boxW + BOX_GAP_X;
            });

            rowY += rowH + BOX_GAP_Y;
        });

        // ── Draw connectors (edge-to-edge only) ──────────────
        // Connect last box of row N to first box of row N+1
        // Route: from bottom-center of source → to top-center of target
        // If they share the same cx, draw a straight vertical line.
        // Otherwise draw an L-shaped path that ONLY travels in the
        // inter-row corridor (no path crosses any box).

        for (let ri = 0; ri < sec.rows.length - 1; ri++) {
            const curRow  = sec.rows[ri];
            const nextRow = sec.rows[ri + 1];

            // Find the "main" connector: last box of curRow → first box of nextRow
            const srcIdx = boxPositions.findIndex(p => p.ri === ri   && p.ci === curRow.length - 1);
            const dstIdx = boxPositions.findIndex(p => p.ri === ri+1 && p.ci === 0);

            if (srcIdx < 0 || dstIdx < 0) continue;

            const src = boxPositions[srcIdx];
            const dst = boxPositions[dstIdx];

            // Mid-corridor Y (halfway between src bottom and dst top)
            const midCorridor = src.bottomY + Math.round(BOX_GAP_Y / 2);

            // Build path that stays in the corridor between rows
            const path = buildEdgeConnector(
                src.cx, src.bottomY,
                dst.cx, dst.topY,
                midCorridor,
                CONNECTOR_W
            );
            lines.push(path);

            // Also connect remaining boxes in current row to their
            // counterpart in the next row (if both rows have > 1 box)
            for (let ci = 0; ci < Math.min(curRow.length, nextRow.length) - 1; ci++) {
                const s2 = boxPositions.find(p => p.ri === ri   && p.ci === ci + 1);
                const d2 = boxPositions.find(p => p.ri === ri+1 && p.ci === ci + 1);
                if (!s2 || !d2) continue;
                lines.push(buildEdgeConnector(
                    s2.cx, s2.bottomY,
                    d2.cx, d2.topY,
                    midCorridor, CONNECTOR_W
                ));
            }
        }
    });

    // Legend
    const legendY = SVG_H - 36;
    lines.push(`<rect x="${MARGIN_X}" y="${legendY}" width="18" height="18" rx="4"
        fill="#ffffff" stroke="#6366f1" stroke-width="1.8"/>`);
    lines.push(`<text x="${MARGIN_X + 24}" y="${legendY + 13}"
        font-size="11" fill="#64748b">Core skill</text>`);
    lines.push(`<rect x="${MARGIN_X + 100}" y="${legendY}" width="18" height="18" rx="4"
        fill="#f8fafc" stroke="#cbd5e1" stroke-width="1" stroke-dasharray="4 3"/>`);
    lines.push(`<text x="${MARGIN_X + 124}" y="${legendY + 13}"
        font-size="11" fill="#64748b">Optional</text>`);
    lines.push(`<text x="${MARGIN_X + 200}" y="${legendY + 13}"
        font-size="11" fill="#64748b">◆ Milestone</text>`);

    lines.push(`</svg>`);
    return lines.join('\n');
}

/**
 * Build an edge-safe connector path between two box edges.
 * The path enters from src bottom-center and exits at dst top-center.
 * All routing stays in the inter-row corridor — never inside a box.
 */
function buildEdgeConnector(srcX, srcBottomY, dstX, dstTopY, corridorY, strokeW) {
    const color  = '#94a3b8';
    const GAP    = 6;   // stop this many px before the destination edge

    if (Math.abs(srcX - dstX) < 4) {
        return `<line x1="${srcX}" y1="${srcBottomY}"
            x2="${dstX}" y2="${dstTopY + GAP}"
            stroke="${color}" stroke-width="${strokeW}"
            marker-end="url(#rm-arrow)" fill="none"/>`;
    }

    const y1 = srcBottomY;
    const y2 = corridorY;
    const y3 = dstTopY + GAP;

    return `<path d="M${srcX} ${y1} L${srcX} ${y2} L${dstX} ${y2} L${dstX} ${y3}"
        fill="none" stroke="${color}" stroke-width="${strokeW}"
        stroke-linecap="round" stroke-linejoin="round"
        marker-end="url(#rm-arrow)"/>`;
}
/** Escape XML special characters for safe SVG text embedding */
function escapeXML(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
// ── END OF ROADMAP LAYOUT ENGINE ─────────────────────────────
function sanitizeDiagramSVG(svg) {
    return String(svg || '')
        .replace(/<script\b[\s\S]*?<\/script>/gi, '')
        .replace(/<(foreignObject|iframe|object|embed|image)\b[\s\S]*?<\/\1>/gi, '')
        .replace(/<(foreignObject|iframe|object|embed|image)\b[^>]*\/?>/gi, '')
        .replace(/\son[a-z]+\s*=\s*(".*?"|'.*?'|[^\s>]+)/gi, '')
        .replace(/\s+(?:href|xlink:href)\s*=\s*(".*?"|'.*?'|[^\s>]+)/gi, '')
        .replace(/\s+style\s*=\s*(".*?"|'.*?'|[^\s>]+)/gi, '')
        .slice(0, 800000);
}
async function generateDiagramSVG(topic, label, fullPrompt) {
    const keyObj = keyPool.getKey('sambanova-deepseek')
                || keyPool.getKey('sambanova-gptoss')
                || keyPool.getKey('chatanywhere')
                || keyPool.getKey('pawan');

    if (!keyObj) {
        return buildFallbackSVG(label);
    }

    const promptText = fullPrompt || label;
    const prompt = `You are an expert SVG diagram designer. Create a clean, educational SVG diagram based on this description:

"${promptText}"

Category hint: ${topic}

Requirements:
- White background (#ffffff)
- viewBox="0 0 760 520"
- Professional educational diagram with consistent scale
- Use colors: #6366f1 (primary), #10b981 (green), #f59e0b (amber), #ef4444 (red), #64748b (gray)
- Reserve the top 55 pixels for the title and do not draw geometry through the title area
- Reserve the left 70 pixels for y-axis labels and the bottom 55 pixels for x-axis labels
- For Cartesian diagrams, use a plot rectangle beginning near x=82 and y=78
- For Cartesian diagrams, calculate every plotted point from the declared mathematical coordinate ranges
- Ensure equal mathematical distances use equal visual scale on both axes unless the description explicitly requires a different scale
- Draw the x-axis and y-axis through the correct mathematical origin
- Draw grid lines and tick labels using the same coordinate transform as the plotted curves
- For functions, plot the actual function with ordered points and do not use decorative or guessed curves
- For geometric laws, use mathematically meaningful triangles, squares, circles, line segments, angle arcs, labels, dimensions, and formulas
- Use separate label positions with at least 16 pixels of clearance from every line
- Do not place text on top of a line, curve, point, axis, or shape edge
- For text over a nearby line, use a white background or white stroke halo around the text
- Use clear whitespace between labels and neighboring shapes
- Font: Arial or sans-serif
- Include a descriptive title at the top

Return ONLY the raw SVG code starting with <svg and ending with </svg>. No markdown, no explanation.`;

    let svgText = '';
    try {
        const data = await callAPI(keyObj, [{ role: 'user', content: prompt }], 2000);
        keyPool.releaseKey(keyObj);
        svgText = data.choices?.[0]?.message?.content || '';
    } catch(e) {
        keyPool.releaseKey(keyObj, e);
        return buildFallbackSVG(label);
    }

    // Extract SVG from response
    const match = svgText.match(/<svg[\s\S]*?<\/svg>/i);
    if (match) return sanitizeDiagramSVG(match[0]);

    return buildFallbackSVG(label);
}

function buildFallbackSVG(label) {
    return `<svg viewBox="0 0 600 200" xmlns="http://www.w3.org/2000/svg" font-family="Arial,sans-serif">
  <rect width="600" height="200" fill="#ffffff" rx="8" stroke="#e2e8f0" stroke-width="1"/>
  <text x="300" y="90" text-anchor="middle" font-size="16" fill="#6366f1" font-weight="700">${label}</text>
  <text x="300" y="118" text-anchor="middle" font-size="12" fill="#94a3b8">Could not generate diagram. Check API connectivity.</text>
</svg>`;
}

async function convertDiagramToFile(svgContent, label, format) {
    if (!svgContent || !svgContent.trim().startsWith('<svg')) {
        throw new Error('Invalid SVG content');
    }
    const tmpId = `diag_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const tmpDir = path.join(os.tmpdir(), tmpId);
    const svgPath = path.join(tmpDir, 'diagram.svg');
    const outPath = path.join(tmpDir, format === 'pdf' ? 'diagram.pdf' : 'diagram.png');
    const pyPath  = path.join(tmpDir, 'convert.py');

    try {
        fs.mkdirSync(tmpDir, { recursive: true });
        fs.writeFileSync(svgPath, svgContent, 'utf-8');

        const pyCode = format === 'pdf' ? `
import sys, os
try:
    from reportlab.graphics import renderPDF
    from svglib.svglib import svg2rlg
    drawing = svg2rlg("${svgPath.replace(/\\/g, '/')}")
    if drawing:
        renderPDF.drawToFile(drawing, "${outPath.replace(/\\/g, '/')}")
    else:
        # fallback: write minimal pdf
        with open("${outPath.replace(/\\/g, '/')}", 'wb') as f:
            f.write(b'%PDF-1.4\\n')
except Exception as e:
    sys.exit(str(e))
` : `
import sys
try:
    import cairosvg
    cairosvg.svg2png(url="${svgPath.replace(/\\/g, '/')}", write_to="${outPath.replace(/\\/g, '/')}", dpi=192)
except ImportError:
    try:
        from PIL import Image
        import subprocess
        subprocess.run(['rsvg-convert', '-d', '192', '-p', '192', '-f', 'png',
                        '-o', "${outPath.replace(/\\/g, '/')}", "${svgPath.replace(/\\/g, '/')}"], check=True)
    except Exception as e2:
        sys.exit(str(e2))
except Exception as e:
    sys.exit(str(e))
`;

        fs.writeFileSync(pyPath, pyCode, 'utf-8');

        await execFileAsync('python3', [pyPath], { timeout: 20000 });

        const result = fs.readFileSync(outPath);
        return result;

    } finally {
        // Always delete temp files after use
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch(e) {}
    }
}

const server = http.createServer(async (req, res) => {
    // ─── Safety: prevent hanging requests ──────────────
    requestCount++;
    const originalEnd = res.end.bind(res);
    let ended = false;
    res.end = function(...args) {
        if (ended) return;
        ended = true;
        return originalEnd(...args);
    };
    const timeoutSafety = setTimeout(() => {
        if (!ended && !res.headersSent) {
            errorCount++;
            res.writeHead(504, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Server timeout' } }));
        }
    }, 65000);
    res.on('close', () => clearTimeout(timeoutSafety));

    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }

    const clientIP = getClientIP(req);

    // ─── User accounts & database (auth-server.js) ─────
    try {
        if (await authServer.handle(req, res, clientIP)) return;
    } catch (authErr) {
        console.error('[AUTH] handler error:', authErr.message);
        try {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'Auth system error' }));
        } catch (_e) { /* response already closed */ }
    }

    // ─── Health endpoint ────────────────────────────────
    if (req.method === 'GET' && req.url === '/health') {
        const stats = keyPool.getStats();
        const memUsage = process.memoryUsage();
        res.writeHead(200, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({
            status: 'ok',
            uptime: Math.floor(process.uptime()),
            timestamp: new Date().toISOString(),
            requests: requestCount,
            errors: errorCount,
            memory: {
                heapUsed: `${(memUsage.heapUsed / 1048576).toFixed(1)} MB`,
                rss: `${(memUsage.rss / 1048576).toFixed(1)} MB`
            },
            keys: {
                total: stats.length,
                available: stats.filter(k => !k.inUse && k.cooldown === 0).length,
                busy: stats.filter(k => k.inUse).length,
                onCooldown: stats.filter(k => k.cooldown > 0).length
            }
        }));
        return;
    }

    // ─── Stats endpoint ─────────────────────────────────
    if (req.method === 'GET' && req.url === '/stats') {
        res.writeHead(200, {'Content-Type': 'application/json'});
        res.end(JSON.stringify(keyPool.getStats()));
        return;
    }

    // ─── Site Registry ──────────────────────────────────────────────────────
    if (req.method === 'GET' && req.url === '/api/movie-sites') {
        const _sf = path.join(__dirname, 'data', 'proxied-sites.json');
        try {
            const _data = fs.existsSync(_sf) ? JSON.parse(fs.readFileSync(_sf, 'utf8')) : {sites:[]};
            res.writeHead(200, {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
            res.end(JSON.stringify(_data));
        } catch(e) {
            res.writeHead(200, {'Content-Type':'application/json'});
            res.end('{"sites":[]}');
        }
        return;
    }
    // ─── Universal Clean Proxy (auto ad-block + anti-paywall for any site) ──
    if (req.method === 'GET' && req.url.startsWith('/api/movie-proxy?')) {
        const _pu = new URL(req.url, 'http://localhost');
        const _target = _pu.searchParams.get('url') || '';
        if (!/^https?:\/\/.+/i.test(_target)) {
            res.writeHead(400, {'Content-Type': 'application/json'});
            res.end(JSON.stringify({ error: 'A valid https:// URL is required' }));
            return;
        }
        // ── Registry: log every proxied site with timestamp ───────────────
        try {
            const _dataDir = path.join(__dirname, 'data');
            if (!fs.existsSync(_dataDir)) fs.mkdirSync(_dataDir, {recursive: true});
            const _sf = path.join(_dataDir, 'proxied-sites.json');
            const _reg = fs.existsSync(_sf) ? JSON.parse(fs.readFileSync(_sf, 'utf8')) : {sites: []};
            const _tu0 = new URL(_target);
            const _originKey = _tu0.origin;
            const _now = new Date().toISOString();
            const _existing = _reg.sites.find(s => s.origin === _originKey);
            if (_existing) {
                _existing.lastVisited = _now;
                _existing.count = (_existing.count || 0) + 1;
                if (!_existing.urls) _existing.urls = [];
                if (!_existing.urls.includes(_target)) _existing.urls.unshift(_target);
                if (_existing.urls.length > 50) _existing.urls = _existing.urls.slice(0, 50);
            } else {
                _reg.sites.unshift({origin: _originKey, firstVisited: _now, lastVisited: _now, count: 1, urls: [_target]});
                if (_reg.sites.length > 500) _reg.sites = _reg.sites.slice(0, 500);
            }
            fs.writeFileSync(_sf, JSON.stringify(_reg, null, 2));
        } catch(_re) { /* registry write failed — non-fatal */ }
        // ── Fetch helper ──────────────────────────────────────────────────
        const _UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
        async function _fmFetch(url, referer) {
            const c = new AbortController();
            const t = setTimeout(() => c.abort(), 10000);
            try {
                const r = await fetch(url, {
                    headers: {
                        'User-Agent': _UA,
                        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                        'Accept-Language': 'en-US,en;q=0.9,ar;q=0.8',
                        'Accept-Encoding': 'gzip, deflate, br',
                        'Referer': referer || 'https://www.google.com/',
                        'Upgrade-Insecure-Requests': '1',
                        'Sec-Fetch-Dest': 'document',
                        'Sec-Fetch-Mode': 'navigate',
                        'Sec-Fetch-Site': referer ? 'same-origin' : 'cross-site',
                        'Cache-Control': 'no-cache'
                    },
                    signal: c.signal,
                    redirect: 'follow'
                });
                clearTimeout(t);
                if (!r.ok) throw new Error('HTTP ' + r.status);
                return await r.text();
            } catch(e) { clearTimeout(t); throw e; }
        }
        function _isUsable(html) {
            if (!html || html.length < 300) return false;
            if (/cf-browser-verification|__cf_chl_opt|jschl_vc|challenge-running|cf_captcha_kind|Checking your browser|challenge-platform\/scripts\/jsd|__CF\$cv\$params/i.test(html)) return false;
            if (/<body[^>]*>\s*<\/body>/i.test(html)) return false;
            return true;
        }
        function _makePassthrough(targetUrl) {
            const _ADpt = /popads\\.net|popcash\\.net|adsterra\\.com|exoclick\\.com|trafficjunky\\.com|clickadu\\.com|adexchangerapid\\.com|sleepoverlimitprofound\\.com|w0wtrackex\\.com/i;
            return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>*{margin:0;padding:0;}html,body{width:100%;height:100%;overflow:hidden;}iframe{width:100%;height:100%;border:none;display:block;}</style></head><body><iframe src="${targetUrl}" id="pf" allowfullscreen allow="autoplay;fullscreen;picture-in-picture;encrypted-media" referrerpolicy="no-referrer-when-downgrade"></iframe><script>(function(){var _AD=${_ADpt};var _o=window.open;window.open=function(u){if(!u||_AD.test(u+''))return null;return _o.apply(this,arguments);};new MutationObserver(function(ms){ms.forEach(function(m){m.addedNodes.forEach(function(n){if(n.nodeType===1&&/activate.*free|sign.up.*watch|register.*watch/i.test(n.innerText||''))n.remove();});});}).observe(document.body,{childList:true,subtree:true});}());<\/script></body></html>`;
        }
        // ── Player iframe extraction (for sites that nest a video player) ─
        function _fmExtractPlayer(html, origin) {
            const skip = /histats|google|facebook|twitter|analytics|recaptcha|register|disqus|amazon-adsystem|googlesyndication|doubleclick/i;
            const playerHint = /\/ip\.temp\/|player|embed|stream|video|watch|jwplayer|flowplayer|hls|m3u8/i;
            const tags = html.match(/<iframe[^>]+>/gi) || [];
            for (const tag of tags) {
                const m = tag.match(/src=["']([^"']+)["']/i);
                if (!m || skip.test(m[1])) continue;
                if (/\/ip\.temp\//i.test(m[1])) return m[1].startsWith('http') ? m[1] : origin + m[1];
            }
            for (const tag of tags) {
                const m = tag.match(/src=["']([^"']+)["']/i);
                if (!m || skip.test(m[1])) continue;
                if (playerHint.test(m[1])) return m[1].startsWith('http') ? m[1] : (m[1].startsWith('/') ? origin + m[1] : m[1]);
            }
            return null;
        }
        // ── Universal HTML cleaner + ad-blocker injector ──────────────────
        function _fmPatchHtml(html, baseOrigin) {
            // Server-side: strip external ad script tags
            const _adSrvRx = /sleepoverlimitprofound\.com|w0wtrackex\.com|adexchangerapid\.com|acscdn\.com|storageimagedisplay\.com|popads\.net|popcash\.net|trafficstars\.com|hilltopads\.com|propellerads\.com|adsterra\.com|juicyads\.com|exoclick\.com|trafficjunky\.com|plugrush\.com|clickadu\.com|mgid\.com|revcontent\.com|outbrain\.com|taboola\.com|googlesyndication\.com|adform\.net|smartadserver\.com|doubleclick\.net|adnxs\.com|rubiconproject\.com|openx\.net|pubmatic\.com|criteo\.com|media\.net|adroll\.com|setupad\.com|ezoic\.com|adskeeper\.co/i;
            html = html.replace(/<script\b[^>]*\bsrc=["']([^"']*)["'][^>]*>[\s\S]*?<\/script>/gi, (m, src) => _adSrvRx.test(src) ? '' : m);
            html = html.replace(/<script\b[^>]*\bsrc=["']([^"']*)["'][^>]*\/>/gi, (m, src) => _adSrvRx.test(src) ? '' : m);
            html = html.replace(/<ins\b[^>]*>[\s\S]*?<\/ins>/gi, '');
            html = html.replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gi, (m, body) => _adSrvRx.test(body) ? '' : m);
            // Server-side: rewrite relative src/href to absolute (safer than <base> for SPAs)
            html = html.replace(/((?:src|href|action)=["'])((?!https?:|\/\/|data:|blob:|javascript:|mailto:|tel:|#|\{|%)([^"']{1,2000}))(["'])/gi, (m, pre, url, _rel, post) => {
                const u = url.trim();
                if (!u || /^(https?:|\/\/|data:|blob:|javascript:|mailto:|tel:|#|\{|%)/.test(u)) return m;
                const abs = u.startsWith('/') ? baseOrigin + u : baseOrigin + '/' + u;
                return pre + abs + post;
            });
            // Server-side: handle lazy-loaded data-src iframes
            html = html.replace(/(<iframe\b[^>]*)\bdata-src=["']([^"']+)["']([^>]*>)/gi, (m, pre, src, post) => {
                if (_adSrvRx.test(src)) return m;
                const absUrl = /^https?:\/\//i.test(src) ? src : src.startsWith('//') ? 'https:' + src : src.startsWith('/') ? baseOrigin + src : baseOrigin + '/' + src;
                return pre + `src="${absUrl}"` + post;
            });
            // Server-side: proxy player iframes so our injected script reaches the actual video player
            const _playerRx = /player|embed|stream|watch|jwplayer|hls|vplayer|iframe\.php|play\.php|video\.php|plyr|flowplayer/i;
            html = html.replace(/<iframe\b([^>]*)>/gi, (m, attrs) => {
                const srcM = attrs.match(/\bsrc=["']([^"']+)["']/i);
                if (!srcM) return m;
                const src = srcM[1].trim();
                if (!src || /^(data:|about:|javascript:|#)/i.test(src)) return m;
                if (src.includes('/api/movie-proxy')) return m;
                if (_adSrvRx.test(src)) return m;
                if (!_playerRx.test(src)) return m;
                const absUrl = /^https?:\/\//i.test(src) ? src :
                               src.startsWith('//') ? 'https:' + src :
                               src.startsWith('/') ? baseOrigin + src :
                               baseOrigin + '/' + src;
                const newAttrs = attrs.replace(/\bsrc=["'][^"']+["']/i,
                    `src="/api/movie-proxy?url=${encodeURIComponent(absUrl)}"`);
                return `<iframe${newAttrs}>`;
            });
            // Client-side: universal ad-blocker + navigation relay
            let _realPath = '/';
            try { const _rpu = new URL(_target); _realPath = _rpu.pathname + _rpu.search + _rpu.hash; } catch(_rpe) {}
            const inject = `<script>(function(){
var _BASE='${baseOrigin}';
var _MYHOST=window.location.hostname;
var _BASEHOST=(function(){try{return new URL(_BASE).hostname;}catch(e){return '';}})();
var _REAL_PATH='${_realPath}';
try{if(_REAL_PATH&&_REAL_PATH!=='/'&&window.location.pathname!==_REAL_PATH){history.replaceState(null,'',_REAL_PATH);}}catch(_hse){}
var _AD=/sleepoverlimitprofound\\.com|w0wtrackex\\.com|adexchangerapid\\.com|acscdn\\.com|storageimagedisplay\\.com|popads\\.net|popcash\\.net|trafficstars\\.com|hilltopads\\.com|propellerads\\.com|adsterra\\.com|juicyads\\.com|exoclick\\.com|trafficjunky\\.com|plugrush\\.com|clickadu\\.com|mgid\\.com|revcontent\\.com|outbrain\\.com|taboola\\.com|googlesyndication\\.com|adform\\.net|smartadserver\\.com|doubleclick\\.net|adnxs\\.com|rubiconproject\\.com|openx\\.net|pubmatic\\.com|criteo\\.com|media\\.net|adroll\\.com|setupad\\.com|ezoic\\.com|adskeeper\\.co|faxro\\.com|mks98\\.com|frs2c\\.com|13o\\.net/i;
var _REG=/\\/register|\\/signup|\\/sign-up|\\/join|\\?.*register/i;
function _isAd(u){return u&&(_AD.test(u)||_REG.test(u));}
function _fixUrl(u){
  if(!u||typeof u!=='string')return u;
  if(/^https?:\\/\\//i.test(u)){
    if(_MYHOST&&_BASEHOST&&_MYHOST!==_BASEHOST){
      try{var _pu=new URL(u);if(_pu.hostname===_MYHOST)return _BASE+_pu.pathname+_pu.search+_pu.hash;}catch(e){}
    }
    return u;
  }
  if(u.charAt(0)==='/'&&u.charAt(1)==='/')return 'https:'+u;
  if(u.charAt(0)==='/')return _BASE+u;
  if(/^(javascript:|data:|blob:|mailto:|tel:|#)/i.test(u))return u;
  return _BASE+'/'+u;
}
var _origOpen=window.open||function(){};
window.open=function(u,t,f){if(!u||_isAd(u+''))return null;return _origOpen.call(this,u,t,f);};
document.addEventListener('mousedown',function(e){var t=e.target;while(t){if(t.tagName==='VIDEO'||t.tagName==='IFRAME')return;t=t.parentElement;}var _o=window.open;window.open=function(){return null;};setTimeout(function(){window.open=_o;},250);},true);
var _oF=window.fetch;window.fetch=function(u,o){var s=_fixUrl(typeof u==='string'?u:(u&&u.url||''));if(typeof u==='string')u=s;else if(u&&u.url)u=new Request(s,u);if(_isAd(s))return Promise.resolve(new Response('',{status:200,statusText:'OK'}));return _oF.call(this,u,o).then(function(r){var ct=r.headers.get('content-type')||'';if(/mpegurl|m3u8/i.test(ct)||/\\.m3u8(\\?|$)/i.test(s)){var _bu=s.substring(0,s.lastIndexOf('/')+1);return r.text().then(function(txt){txt=txt.replace(/^([^#\\r\\n][^\\r\\n]*)$/gm,function(seg){var t=seg.trim();if(!t)return seg;if(/^https?:\\/\\//i.test(t))return seg;if(t.charAt(0)==='/'&&t.charAt(1)==='/')return 'https:'+t;if(t.charAt(0)==='/')return _BASE+t;return _bu+t;});return new Response(txt,{status:r.status,statusText:r.statusText,headers:r.headers});});}return r;});};
var _oXO=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u){var s=_fixUrl(u+'');if(_isAd(s))return;return _oXO.apply(this,[m,s].concat(Array.prototype.slice.call(arguments,2)));};
var _oCE=document.createElement.bind(document);
document.createElement=function(tag){
  var el=_oCE(tag);
  if((tag+'').toLowerCase()==='script'){
    var d=Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype,'src');
    if(d&&d.set){Object.defineProperty(el,'src',{configurable:true,get:d.get,set:function(v){if(_isAd(v+''))return;d.set.call(this,v);}});}
  }
  return el;
};
try{var _la=window.location.assign.bind(window.location),_lr=window.location.replace.bind(window.location);window.location.assign=function(u){if(!_isAd(u))_la(u);};window.location.replace=function(u){if(!_isAd(u))_lr(u);};}catch(e){}
function _rmAds(){
  try{
    document.querySelectorAll('div,section,aside,ins,article,figure').forEach(function(el){
      var cs=window.getComputedStyle(el);
      var isOverlay=(cs.position==='fixed'||cs.position==='sticky')&&parseInt(cs.zIndex||0,10)>100&&el.offsetWidth>100&&el.offsetHeight>60;
      var isWall=/activate.*free|create.*account.*watch|sign.*up|register.*watch|subscribe.*watch|log.*in.*watch|please.*register|to.*continue.*watch/i.test(el.innerText||'');
      if(isOverlay||isWall){try{el.parentNode&&el.parentNode.removeChild(el);}catch(e){el.style.cssText='display:none!important;visibility:hidden!important;';}}
    });
    document.querySelectorAll('iframe[src]').forEach(function(f){try{var cs=window.getComputedStyle(f);var isOv=(cs.position==='fixed'||cs.position==='sticky')&&parseInt(cs.zIndex||0,10)>50;if(isOv&&_isAd(f.src||''))f.src='about:blank';}catch(e){}});
    if(document.body){document.body.style.overflow='auto';}
    if(document.documentElement){document.documentElement.style.overflow='auto';}
  }catch(e){}
}
function _vidIsPlaying(){var vs=document.querySelectorAll('video');for(var i=0;i<vs.length;i++){if(!vs[i].paused&&!vs[i].ended&&vs[i].readyState>=2)return true;}return false;}
document.addEventListener('DOMContentLoaded',function(){_rmAds();setTimeout(function(){_rmAds();},1000);setTimeout(function(){_rmAds();},3500);setInterval(function(){if(!_vidIsPlaying())_rmAds();},5000);});
setTimeout(function(){_rmAds();},400);
document.addEventListener('click',function(e){
  var a=e.target;while(a&&a.tagName!=='A')a=a.parentElement;
  if(!a||!a.href)return;
  var h=a.href;
  if(!h||/^(#|javascript:|mailto:|tel:|data:)/i.test(h))return;
  try{var u=new URL(h);if(u.origin===_BASE){e.preventDefault();e.stopPropagation();window.parent.postMessage({type:'fms-nav',url:h},'*');}}catch(ex){}
},true);
document.addEventListener('submit',function(e){
  var fm=e.target;if(!fm)return;
  try{
    var u=new URL(fm.action||window.location.href);
    if(u.origin===_BASE){
      e.preventDefault();e.stopPropagation();
      if((fm.method||'get').toLowerCase()==='get'){new URLSearchParams(new FormData(fm)).forEach(function(v,k){u.searchParams.set(k,v);});}
      window.parent.postMessage({type:'fms-nav',url:u.toString()},'*');
    }
  }catch(ex){}
},true);
}());<\/script>`;
            if (/<head\b/i.test(html)) return html.replace(/(<head\b[^>]*>)/i, '$1' + inject);
            if (/<html\b/i.test(html)) return html.replace(/(<html\b[^>]*>)/i, '$1' + inject);
            return inject + html;
        }
        // ── Serve cleaned page ────────────────────────────────────────────
        try {
            const origin = new URL(_target).origin;
            const isFMS = /fullmoviesell\.com/i.test(_target);
            const isPlayerUrl = /\/ip\.temp\//i.test(_target);
            let htmlOut;
            let rawHtml = null;
            try { rawHtml = await _fmFetch(_target); } catch(_fe) { /* fetch failed */ }
            if (!rawHtml || !_isUsable(rawHtml)) {
                // Cloudflare challenge, empty page, timeout, or fetch error → pass-through
                htmlOut = _makePassthrough(_target);
            } else if (isFMS && !isPlayerUrl) {
                const playerUrl = _fmExtractPlayer(rawHtml, origin);
                if (playerUrl) {
                    try { htmlOut = _fmPatchHtml(await _fmFetch(playerUrl, _target), new URL(playerUrl).origin); }
                    catch(_pe) { htmlOut = _fmPatchHtml(rawHtml, origin); }
                } else {
                    htmlOut = _fmPatchHtml(rawHtml, origin);
                }
            } else {
                htmlOut = _fmPatchHtml(rawHtml, origin);
            }
            res.writeHead(200, {
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': 'no-store',
                'Access-Control-Allow-Origin': '*',
                'X-Frame-Options': 'ALLOWALL',
                'Content-Security-Policy': ''
            });
            res.end(htmlOut);
        } catch(e) {
            res.writeHead(500, {'Content-Type': 'application/json'});
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }
    // ─── AssemblyAI transcription proxy ─────────────────
    if (req.method === 'POST' && req.url === '/api/assemblyai/transcribe') {
        const AAI_KEY = process.env.ASSEMBLYAI_KEY;
        if (!AAI_KEY) {
            res.writeHead(500, {'Content-Type': 'application/json'});
            res.end(JSON.stringify({ error: 'ASSEMBLYAI_KEY not set in .env' }));
            return;
        }
        const chunks = [];
        let _audioBytes = 0;
        req.on('data', c => {
            _audioBytes += c.length;
            if (_audioBytes > 60 * 1024 * 1024) { rejectBigBody(req, res); return; }
            chunks.push(c);
        });
        req.on('end', async () => {
            try {
                const audioBuffer = Buffer.concat(chunks);
                // Step 1: upload audio
                const uploadRes = await fetch('https://api.assemblyai.com/v2/upload', {
                    method: 'POST',
                    headers: { 'authorization': AAI_KEY, 'content-type': 'application/octet-stream' },
                    body: audioBuffer
                });
                if (!uploadRes.ok) throw new Error(`Upload failed ${uploadRes.status}`);
                const { upload_url } = await uploadRes.json();
                // Step 2: request transcript with word confidence
                const transcriptRes = await fetch('https://api.assemblyai.com/v2/transcript', {
                    method: 'POST',
                    headers: { 'authorization': AAI_KEY, 'content-type': 'application/json' },
                    body: JSON.stringify({
                        audio_url: upload_url,
                        language_code: 'en_us',
                        disfluencies: true
                    })
                });
                if (!transcriptRes.ok) throw new Error(`Transcript request failed ${transcriptRes.status}`);
                const { id } = await transcriptRes.json();
                // Step 3: poll until done (max 30s)
                let result = null;
                for (let i = 0; i < 30; i++) {
                    await new Promise(r => setTimeout(r, 1000));
                    const pollRes = await fetch(`https://api.assemblyai.com/v2/transcript/${id}`, {
                        headers: { 'authorization': AAI_KEY }
                    });
                    const pollData = await pollRes.json();
                    if (pollData.status === 'completed') { result = pollData; break; }
                    if (pollData.status === 'error') throw new Error(`AssemblyAI error: ${pollData.error}`);
                }
                if (!result) throw new Error('Transcription timed out');
                res.writeHead(200, {'Content-Type': 'application/json'});
                res.end(JSON.stringify({ text: result.text, words: result.words }));
            } catch(e) {
                console.error('[AssemblyAI]', e.message);
                res.writeHead(500, {'Content-Type': 'application/json'});
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }
    
    // ─── Serve chat interface ───────────────────────────
    if (req.method === 'GET' && (req.url === '/' || req.url === '/chat.html')) {
        try {
            const page = getChatPage();
            const headers = {
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': 'no-cache',
                'ETag': page.etag,
                'Vary': 'Accept-Encoding'
            };
            if (req.headers['if-none-match'] === page.etag) {
                res.writeHead(304, headers);
                res.end();
                return;
            }
            if (/\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))) {
                headers['Content-Encoding'] = 'gzip';
                headers['Content-Length'] = page.gz.length;
                res.writeHead(200, headers);
                res.end(page.gz);
            } else {
                headers['Content-Length'] = page.raw.length;
                res.writeHead(200, headers);
                res.end(page.raw);
            }
        } catch (e) {
            res.writeHead(404, {'Content-Type': 'application/json'});
            res.end(JSON.stringify({ error: 'Chat interface not found' }));
        }
        return;
    }
    
    // ═══ SERVE STATIC FILES FROM public/ ═══
    if (req.method === 'GET') {
        let filePath = req.url.split('?')[0]; // Remove query string
        if (filePath === '/') filePath = '/index.html';
        
        const fullPath = path.join(__dirname, 'public', filePath);
        const ext = path.extname(fullPath);
        const contentTypes = {
            '.html': 'text/html',
            '.css': 'text/css',
            '.js': 'application/javascript',
            '.json': 'application/json',
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.svg': 'image/svg+xml',
            '.ico': 'image/x-icon'
        };
        
        if (contentTypes[ext]) {
            try {
                if (fs.existsSync(fullPath)) {
                    res.writeHead(200, { 'Content-Type': contentTypes[ext] });
                    res.end(fs.readFileSync(fullPath));
                    return;
                }
            } catch(e) {}
        }
    }

    // ═══════════════════════════════════════════════════════
    // YOUTUBE CAPTIONS ENDPOINT (ASYNC & SAFE — SINGLE COPY)
    // ═══════════════════════════════════════════════════════
    if (req.method === 'GET' && req.url.startsWith('/api/youtube/captions')) {
        const urlParams = new URL(req.url, `http://localhost:${PORT}`).searchParams;
        const videoId = urlParams.get('videoId');

        if (!videoId || !isValidYouTubeId(videoId)) {
            res.writeHead(400, {'Content-Type': 'application/json'});
            res.end(JSON.stringify({ error: 'Missing or invalid videoId parameter' }));
            return;
        }

        console.log(`[YouTube] Fetching captions for: ${videoId}`);
        
        // Serve from cache if available
        const cached = captionCache.get(videoId);
        if (cached) {
            console.log(`[YouTube] Cache hit for ${videoId}`);
            res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end(JSON.stringify({ captions: cached, count: cached.length, method: 'cache' }));
            return;
        }
        
        let captions = []; // Must be declared here to be accessible by Method 2 and final response!
        let usedMethod = '';

        // ── METHOD 1: ANDROID Innertube + XML captions ─────────
        try {
            const ctrl = new AbortController();
            const ctrlTimer = setTimeout(() => ctrl.abort(), 15000);
            const playerRes = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'User-Agent': 'com.google.android.youtube/20.10.38 (Linux; U; Android 14)'
                },
                body: JSON.stringify({
                    context: { client: { clientName: 'ANDROID', clientVersion: '20.10.38' } },
                    videoId
                }),
                signal: ctrl.signal
            });
            clearTimeout(ctrlTimer);
            if (playerRes.ok) {
                const playerData = await playerRes.json();
                const status = playerData?.playabilityStatus?.status;
                if (status === 'UNPLAYABLE' || status === 'LOGIN_REQUIRED' || status === 'ERROR') {
                    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                    res.end(JSON.stringify({ captions: [], count: 0, method: 'none', error: 'Video is unavailable or private' }));
                    return;
                }
                const tracks = playerData?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
                const enTrack = tracks.find(t => t.languageCode === 'en' || t.languageCode?.startsWith('en-')) || tracks[0];
                if (enTrack?.baseUrl) {
                    const capRes = await fetch(enTrack.baseUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
                    if (capRes.ok) {
                        const xml = await capRes.text();
                        const pRegex = /<p[^>]*\bt="(\d+)"[^>]*\bd="(\d+)"[^>]*>([\s\S]*?)<\/p>/g;
                        let m2;
                        while ((m2 = pRegex.exec(xml)) !== null) {
                            const captionStart = parseInt(m2[1], 10) / 1000;
                            const captionDur = parseInt(m2[2], 10) / 1000;
                            const rawText = _decodeCaptionText(m2[3]);

                            const segments = [];
                            const segmentRegex = /<s([^>]*)>([\s\S]*?)<\/s>/g;
                            let segmentMatch;

                            while ((segmentMatch = segmentRegex.exec(m2[3])) !== null) {
                                const attributes = segmentMatch[1];
                                const offsetMatch = attributes.match(/\bt="(\d+)"/);
                                const durationMatch = attributes.match(/\bd="(\d+)"/);

                                segments.push({
                                    text: segmentMatch[2],
                                    offset: offsetMatch
                                        ? parseInt(offsetMatch[1], 10) / 1000
                                        : 0,
                                    dur: durationMatch
                                        ? parseInt(durationMatch[1], 10) / 1000
                                        : 0
                                });
                            }

                            if (rawText) {
                                captions.push({
                                    text: rawText,
                                    start: captionStart,
                                    dur: captionDur,
                                    words: _buildTimedCaptionWords(
                                        segments.length
                                            ? segments
                                            : [{ text: rawText, offset: 0, dur: captionDur }],
                                        captionStart,
                                        captionDur
                                    )
                                });
                            }
                        }
                        if (captions.length > 0) {
                            usedMethod = 'android-captions';
                            console.log(`[YouTube] ✅ Android client found ${captions.length} captions for ${videoId}`);
                        }
                    }
                }
            }
        } catch (e) {
            console.log('[YouTube] Android captions failed:', e.message?.substring(0, 80));
        }

        // ── METHOD 1b: yt-dlp fallback (only if Android found nothing) ──
        const tmpDir = `/tmp/yt_captions_${Date.now()}`;
        if (captions.length === 0) try {
            fs.mkdirSync(tmpDir, { recursive: true });

            const ytArgs = [
                '--skip-download', '--write-subs', '--write-auto-subs',
                '--sub-lang', 'en,en-US,en-GB',
                '--sub-format', 'srt/vtt/json3/ttml',
                '--convert-subs', 'srt',
                '--output', `${tmpDir}/%(id)s.%(ext)s`,
                '--no-warnings', '--no-playlist',
                `https://www.youtube.com/watch?v=${videoId}`
            ];

            await execFileAsync('yt-dlp', ytArgs, {
                timeout: 30000,
                maxBuffer: 10 * 1024 * 1024
            });

            const files = fs.readdirSync(tmpDir);
            const subFiles = files.filter(f =>
                f.endsWith('.srt') || f.endsWith('.vtt') ||
                f.endsWith('.json') || f.endsWith('.ttml')
            );

            if (subFiles.length > 0) {
                console.log(`[YouTube] Found ${subFiles.length} subtitle files via yt-dlp`);

                const enFiles = subFiles.filter(f =>
                    f.includes('.en.') || f.includes('-en.')
                );
                const targetFile = (enFiles.length > 0 ? enFiles : subFiles)[0];
                const rawContent = fs.readFileSync(`${tmpDir}/${targetFile}`, 'utf-8');
                const ext = targetFile.split('.').pop()?.toLowerCase() || 'srt';
                console.log(`[YouTube] Parsing ${ext} file (${rawContent.length} chars)`);

                captions = parseSubtitleFile(rawContent, ext);
                usedMethod = `yt-dlp-${ext}`;
            } else {
                // Fallback: get subtitle URLs from dump-json
                const infoArgs = [
                    '--skip-download', '--dump-json',
                    '--no-warnings', '--no-playlist',
                    `https://www.youtube.com/watch?v=${videoId}`
                ];

                const { stdout: infoResult } = await execFileAsync('yt-dlp', infoArgs, {
                    timeout: 15000,
                    maxBuffer: 10 * 1024 * 1024
                });

                const infoData = JSON.parse(infoResult);
                const allSubs = {
                    ...(infoData.subtitles || {}),
                    ...(infoData.automatic_captions || {})
                };

                let foundUrl = null;
                for (const code of ['en', 'en-US', 'en-GB']) {
                    const subs = allSubs[code];
                    if (subs && subs.length > 0) {
                        const targetSub = subs.find(s => s.ext === 'srt')
                                       || subs.find(s => s.ext === 'vtt')
                                       || subs[0];
                        if (targetSub?.url) {
                            foundUrl = targetSub.url;
                            console.log(`[YouTube] Found ${code} subtitles (${targetSub.ext})`);
                            break;
                        }
                    }
                }

                if (!foundUrl) {
                    for (const [code, subs] of Object.entries(allSubs)) {
                        if (subs && subs.length > 0 && subs[0]?.url) {
                            foundUrl = subs[0].url;
                            console.log(`[YouTube] Using ${code} subtitles as fallback`);
                            break;
                        }
                    }
                }

                if (foundUrl) {
                    const response = await fetch(foundUrl, {
                        headers: { 'User-Agent': 'Mozilla/5.0' }
                    });
                    if (response.ok) {
                        const rawContent = await response.text();
                        captions = parseSubtitleFile(rawContent, 'vtt');
                        usedMethod = 'yt-dlp-url';
                    }
                }
            }
        } catch (e) {
            const msg = e.message || '';
            console.log('[YouTube] yt-dlp method failed:', msg.substring(0, 80));

            // Only bail out as unavailable if Android also found nothing
            if (captions.length === 0 &&
                (msg.includes('not available') || msg.includes('Private video') ||
                 msg.includes('has been removed') || msg.includes('sign in'))) {
                
                try { fs.rmSync(tmpDir, { recursive: true }); } catch(e2) {}
                
                res.writeHead(200, {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                });
                res.end(JSON.stringify({
                    captions: [],
                    count: 0,
                    method: 'none',
                    error: 'Video is unavailable or private'
                }));
                return;
            }
        } finally {
            // ALWAYS clean up yt-dlp temp directory
            try { fs.rmSync(tmpDir, { recursive: true }); } catch(e) {}
        } // end if (captions.length === 0)

        // ── METHOD 2: Python youtube-transcript-api (async, injection-safe) ──
        if (captions.length === 0) {
            try {
                const tmpFile = path.join(os.tmpdir(), `py_${Date.now()}_${Math.random().toString(36).slice(2)}.py`);
                const pythonCode = `import json, sys\ntry:\n    from youtube_transcript_api import YouTubeTranscriptApi\n    transcript = YouTubeTranscriptApi.get_transcript(sys.argv[1])\n    print(json.dumps(transcript))\nexcept Exception as e:\n    print(json.dumps({"error": str(e)}))`;
                fs.writeFileSync(tmpFile, pythonCode);

                const { stdout: result } = await execFileAsync('python3', [tmpFile, videoId], {
                    timeout: 20000,
                    maxBuffer: 5 * 1024 * 1024
                });

                try { fs.unlinkSync(tmpFile); } catch(e) {}

                const data = JSON.parse(result);
                if (!data.error && Array.isArray(data)) {
                    captions = data.map(item => ({
                        text: item.text || '',
                        start: item.start || 0,
                        dur: item.duration || 3
                    }));
                    usedMethod = 'python-api';
                    console.log(`[YouTube] ✅ Python found ${captions.length} captions`);
                }
            } catch (e) {
                console.log('[YouTube] Python failed:', e.message?.substring(0, 60));
            }
        }

        console.log(`[YouTube] Found ${captions.length} captions via ${usedMethod || 'none'}`);

        res.writeHead(200, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
        });
        if (captions.length > 0) captionCache.set(videoId, captions);
        res.end(JSON.stringify({
            captions: captions,
            count: captions.length,
            method: usedMethod || 'none'
        }));
        return;
    }

    // ═══════════════════════════════════════════════════════
    // WORD ANALYSIS ENDPOINT
    // ═══════════════════════════════════════════════════════
    if (req.method === 'GET' && req.url.startsWith('/api/word-analysis')) {
        const urlParams = new URL(req.url, `http://localhost:${PORT}`).searchParams;
        const word = urlParams.get('word');

        if (!word) {
            res.writeHead(400, {'Content-Type': 'application/json'});
            res.end(JSON.stringify({ error: 'Missing word parameter' }));
            return;
        }

        console.log(`[Word] Analyzing: "${word}"`);

        try {
            // Step 1: Free Dictionary API
            let dictData = null;
            try {
                const dictRes = await fetch(
                    `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`,
                    { headers: { 'User-Agent': 'AI-Assistant/1.0' } }
                );
                if (dictRes.ok) {
                    const json = await dictRes.json();
                    if (Array.isArray(json) && json[0]) dictData = json[0];
                }
            } catch (dictErr) {
                console.log('[Word] Free Dictionary API failed:', dictErr.message);
            }

            // Step 2: Enhance with DeepSeek
            const keyObj = keyPool.getKey('sambanova-deepseek')
                        || keyPool.getKey('sambanova-gptoss')
                        || keyPool.getKey('pawan');

            if (!keyObj) {
                if (dictData) {
                    res.writeHead(200, {'Content-Type': 'application/json'});
                    res.end(JSON.stringify(parseDictionaryData(dictData)));
                    return;
                }
                res.writeHead(503, {'Content-Type': 'application/json'});
                res.end(JSON.stringify({ error: 'DeepSeek is busy, try again in a moment' }));
                return;
            }

            const dictDefs = (dictData?.meanings || [])
                .flatMap(m => m.definitions?.map(d => d.definition) || [])
                .slice(0, 3).join('; ');
            const dictHint = dictDefs ? `Free Dictionary context: ${dictDefs}` : '';

            const prompt = `Analyze the English word "${word}" for a language learner. ${dictHint}
Return ONLY a valid JSON object with no markdown:
{
  "word": "${word}",
  "phonetic": "IPA pronunciation",
  "partOfSpeech": ["noun", "verb"],
  "origin": "brief etymology",
  "register": "formal OR informal OR neutral",
  "difficulty": "A1 OR A2 OR B1 OR B2 OR C1 OR C2",
  "synonyms": ["syn1","syn2","syn3","syn4","syn5"],
  "antonyms": ["ant1","ant2","ant3"],
  "definitions": [
    {"pos":"noun","def":"definition text","example":"example sentence"},
    {"pos":"verb","def":"definition text","example":"example sentence"}
  ],
  "collocations": ["phrase 1","phrase 2","phrase 3","phrase 4"]
}`;

            const aiData = await callAPI(keyObj, [{ role: 'user', content: prompt }], 700);
            keyPool.releaseKey(keyObj);

            const aiContent = aiData.choices?.[0]?.message?.content || '';
            const jsonMatch = aiContent.match(/\{[\s\S]*\}/);

            let wordData = null;
            if (jsonMatch) {
                try {
                    wordData = JSON.parse(jsonMatch[0]);
                } catch (e) {
                    try {
                        wordData = JSON.parse(
                            jsonMatch[0].replace(/,\s*}/g, '}').replace(/,\s*]/g, ']')
                        );
                    } catch (e2) {}
                }
            }

            // Step 3: Merge AI result with dictionary data
            if (wordData && dictData) {
                const parsed = parseDictionaryData(dictData);
                wordData.phonetic = wordData.phonetic || parsed.phonetic;
                wordData.audio    = parsed.audio;
                wordData.origin   = wordData.origin || parsed.origin;
                const mergedSyns = [...new Set([...(wordData.synonyms || []), ...parsed.synonyms])];
                const mergedAnts = [...new Set([...(wordData.antonyms || []), ...parsed.antonyms])];
                wordData.synonyms = mergedSyns.slice(0, 10);
                wordData.antonyms = mergedAnts.slice(0, 6);
            } else if (!wordData && dictData) {
                wordData = parseDictionaryData(dictData);
            }

            if (wordData) {
                res.writeHead(200, {'Content-Type': 'application/json'});
                res.end(JSON.stringify(wordData));
            } else {
                throw new Error('Could not build word data');
            }

        } catch (err) {
            console.error('[Word] Analysis error:', err.message);
            res.writeHead(200, {'Content-Type': 'application/json'});
            res.end(JSON.stringify({
                word, phonetic: '', audio: null, origin: '',
                partOfSpeech: [], synonyms: [], antonyms: [],
                definitions: [{ pos: 'unknown', def: `Could not load definition for "${word}"`, example: '' }],
                collocations: [], register: 'neutral', difficulty: 'B1'
            }));
        }
        return;
    }

    // ═══════════════════════════════════════════════════════
    // PROFESSIONAL TRANSLATION ENDPOINT
    // ═══════════════════════════════════════════════════════
        if (req.method === 'GET' && req.url === '/api/blackbox/session-status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ sessions: blackboxSessionManager.getStatus() }));
        return;
    }

    if (req.method === 'POST' && req.url === '/api/blackbox/validate-session') {
        let body = '';
        req.on('data', c => { body += c; if (body.length > MAX_BODY_CHARS) rejectBigBody(req, res); });
        req.on('end', async () => {
            try {
                const parsed = body ? JSON.parse(body) : {};
                // Accept optional new session credentials to add
                if (parsed.sessionId && parsed.validated) {
                    blackboxSessionManager.addSession(parsed.sessionId, parsed.validated);
                }
                // Test all sessions in parallel
                const results = await Promise.all(
                    blackboxSessionManager.sessions.map(async (s) => {
                        const probe = await validateBlackboxSession(s);
                        return {
                            sessionId: s.sessionId.slice(0, 8) + '…',
                            alive: s.alive,
                            failCount: s.failCount,
                            probeResult: probe
                        };
                    })
                );
                const anyAlive = results.some(r => r.alive);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    ok: anyAlive,
                    sessionsTested: results.length,
                    aliveSessions: results.filter(r => r.alive).length,
                    sessions: results
                }));
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }
    
    if (req.method === 'POST' && req.url === '/api/translate') {
        let body = '';
        req.on('data', c => { body += c; if (body.length > MAX_BODY_CHARS) rejectBigBody(req, res); });
        req.on('end', async () => {
            try {
                const { text, targetLang, style, dialect } = JSON.parse(body);

                if (!text || !targetLang || !style) {
                    res.writeHead(400, {'Content-Type': 'application/json'});
                    res.end(JSON.stringify({ error: 'Missing text, targetLang, or style' }));
                    return;
                }

                let keyObj = keyPool.getKey('pawan');
                if (!keyObj) keyObj = keyPool.getKey('sambanova-gptoss');
                if (!keyObj) {
                    res.writeHead(503, {'Content-Type': 'application/json'});
                    res.end(JSON.stringify({ error: 'All providers busy, retry in a moment' }));
                    return;
                }

                const langNames = { ar: 'Arabic', de: 'German' };
                const langName  = langNames[targetLang] || targetLang;

                const styleGuides = {
                    manual:       'Provide a word-for-word literal translation. Preserve original structure as closely as possible.',
                    casual:       'Translate naturally as a friend would speak — relaxed, everyday language, contractions welcome, conversational tone.',
                    formal:       'Use polite, respectful language appropriate for official correspondence and professional meetings.',
                    academic:     'Use precise scholarly language with appropriate technical vocabulary. Maintain an academic register with complex sentence structures where natural.',
                    professional: 'Use clear, concise business language suitable for corporate communications, reports, and client-facing documents.'
                };

                const arDialectNotes = {
                    msa:       'Use Modern Standard Arabic (MSA / فصحى). Clear, formal, universally understood.',
                    egyptian:  'Use Egyptian Arabic dialect (عامية مصرية). Natural Cairo street speech. Use words like: إيه، ده، دي، مش، عايز، بتاع، أوي، كده، معلش، يلا. Avoid فصحى vocabulary.',
                    gulf:      'Use Gulf Arabic dialect (خليجي). Use words like: وش، كيف، شلون، ليش، حق، زين، هالـ, وايد. Avoid Egyptian or Levantine slang.',
                    levantine: 'Use Levantine Arabic dialect (شامي — Syrian/Lebanese). Use words like: شو، هيك، كتير، مشان، بدي، هلق، يعني، رح، منيح. Avoid Gulf or Egyptian slang.',
                    moroccan:  'Use Moroccan Darija dialect (دارجة مغربية). Use words like: واش، ديال، كاين، غادي، بزاف، هادا، فين، كيفاش. Mix in French loanwords where natural.'
                };

                const selectedDialect = (targetLang === 'ar' && dialect) ? dialect : 'msa';

                const langSpecificNote = targetLang === 'de'
                    ? 'Use standard German (Hochdeutsch). For formal: use Sie-form. For casual: use du-form.'
                    : targetLang === 'ar'
                    ? arDialectNotes[selectedDialect] || arDialectNotes.msa
                    : '';

                const userPrompt = `Translate this English text to ${langName}.
Style: ${style}. ${langSpecificNote}
 ${styleGuides[style] || styleGuides.formal}

Source text: "${text}"

Return ONLY valid JSON, no markdown, no preamble:
{
  "translation": "the ${langName} translation here",
  "style": "${style}",
  "targetLang": "${targetLang}",
  "notes": "any important cultural/translation note, or empty string",
  "alternatives": ["alternative phrasing 1", "alternative phrasing 2"]
}`;

                let data;
                try {
                    data = await callAPI(keyObj, [{ role: 'user', content: userPrompt }], 800);
                    keyPool.releaseKey(keyObj);
                } catch (e) {
                    keyPool.releaseKey(keyObj, e);
                    console.log('[Translate] Primary failed, trying GitHub AI...');
                    try {
                        const ghContent = await callGitHubAI(userPrompt, 800);
                        data = { choices: [{ message: { content: ghContent } }] };
                    } catch (e2) {
                        console.error('[Translate] Both providers failed:', e2.message);
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'All translation providers busy' }));
                        return;
                    }
                }

                const content = data.choices?.[0]?.message?.content || '';
                const stripped = content.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
                const jsonMatch = stripped.match(/\{[\s\S]*?\}/s);

                if (jsonMatch) {
                    try {
                        const result = JSON.parse(jsonMatch[0]);
                        res.writeHead(200, {'Content-Type': 'application/json'});
                        res.end(JSON.stringify(result));
                        return;
                    } catch (e) {
                        try {
                            const result = JSON.parse(
                                jsonMatch[0].replace(/,\s*}/g, '}').replace(/,\s*]/g, ']')
                            );
                            res.writeHead(200, {'Content-Type': 'application/json'});
                            res.end(JSON.stringify(result));
                            return;
                        } catch (e2) {}
                    }
                }

                res.writeHead(200, {'Content-Type': 'application/json'});
                res.end(JSON.stringify({
                    translation: content.replace(/```json|```/g, '').trim(),
                    style, targetLang, notes: '', alternatives: []
                }));

            } catch (e) {
                if (!ended && !res.headersSent) {
                    res.writeHead(500, {'Content-Type': 'application/json'});
                    res.end(JSON.stringify({ error: e.message }));
                }
            }
        });
        return;
    }

    // ═══════════════════════════════════════════════════════
    // MEMORY AI ENDPOINTS
    // ═══════════════════════════════════════════════════════
    if (req.method === 'POST' && req.url === '/api/chat/memory') {
        if (!checkRateLimit(clientIP, 30, 60000)) {
            res.writeHead(429, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Rate limited. Try again in 60 seconds.' } }));
            return;
        }
        let body = '';
        req.on('data', c => { body += c; if (body.length > MAX_BODY_CHARS) rejectBigBody(req, res); });
        req.on('end', async () => {
            try {
                const { message, history = [] } = JSON.parse(body);
                const response = await fetch('http://localhost:3000/chat', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ message, history })
                });
                const data = await response.json();
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, response: data.response, provider: 'Memory AI' }));
            } catch (e) {
                if (!ended && !res.headersSent) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: e.message }));
                }
            }
        });
        return;
    }

    if (req.method === 'GET' && req.url === '/api/memory/status') {
        try {
            const response = await fetch('http://localhost:3000/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: 'ping' })
            });
            if (response.ok) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: 'online', port: 3000 }));
            } else { throw new Error('Not responding'); }
        } catch (e) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'offline', error: e.message }));
        }
        return;
    }

    if (req.method === 'POST' && req.url === '/api/memory/save') {
        let body = '';
        req.on('data', c => { body += c; if (body.length > MAX_BODY_CHARS) rejectBigBody(req, res); });
        req.on('end', async () => {
            try {
                const { sessionId, messages } = JSON.parse(body);
                if (memoryConversations.size >= MAX_MEMORY_CONVERSATIONS) {
                    let oldestKey = null, oldestTime = Infinity;
                    for (const [key, val] of memoryConversations) {
                        if (val.timestamp < oldestTime) { oldestTime = val.timestamp; oldestKey = key; }
                    }
                    if (oldestKey) memoryConversations.delete(oldestKey);
                }
                memoryConversations.set(sessionId, { messages, timestamp: Date.now() });
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true }));
            } catch (e) {
                if (!ended && !res.headersSent) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: e.message }));
                }
            }
        });
        return;
    }

    if (req.method === 'GET' && req.url === '/api/memory/load') {
        const urlParams = new URL(req.url, `http://localhost:${PORT}`).searchParams;
        const sessionId = urlParams.get('sessionId');
        if (!sessionId) {
            res.writeHead(400, {'Content-Type': 'application/json'});
            res.end(JSON.stringify({ error: 'Missing sessionId' }));
            return;
        }
        const record = memoryConversations.get(sessionId);
        if (record) record.timestamp = Date.now(); // Refresh TTL
        res.writeHead(200, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({ messages: record ? record.messages : [] }));
        return;
    }

    if (req.method === 'GET' && req.url === '/api/memory/info') {
        try {
            const response = await fetch('http://localhost:3000/info', {
                method: 'GET',
                headers: { 'Content-Type': 'application/json' }
            }).catch(() => null);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                name: 'Memory AI', port: 3000,
                status: response ? 'online' : 'unknown',
                capabilities: ['long_responses', 'translation', 'conversation_memory', 'text_generation']
            }));
        } catch (e) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ name: 'Memory AI', port: 3000, status: 'unknown' }));
        }
        return;
    }

    // ═══════════════════════════════════════════════════════
    // PROVIDERS LIST
    // ═══════════════════════════════════════════════════════
    if (req.method === 'GET' && req.url === '/api/providers') {
        const providers = [
            { id: 'auto', name: 'Auto (Best Available)', type: 'internal' },
            { id: 'blackbox', name: 'Blackbox', type: 'api', free: true }, 
            { id: 'memory', name: 'Memory AI (Long Responses)', type: 'external', port: 3000 },
            { id: 'sambanova', name: 'DeepSeek-V3.2 (671B)', type: 'api' },
            { id: 'sambanova-gptoss', name: 'GPT-OSS 120B', type: 'api' },
            { id: 'pawan', name: 'GPT-OSS 20B', type: 'api' },
            { id: 'pawan', name: 'GPT-NANO', type: 'api' },
            { id: 'serpapi', name: 'Google AI Mode Search', type: 'search' },
            { id: 'google_cse', name: 'DeepGoogling', type: 'search' },
            { id: 'serpapi_jobs', name: 'Google Jobs Search', type: 'search' }
        ];
        try {
            const memoryCheck = await fetch('http://localhost:3000/chat', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: 'ping' })
            });
            providers.find(p => p.id === 'memory').status = memoryCheck.ok ? 'online' : 'offline';
        } catch (e) {
            providers.find(p => p.id === 'memory').status = 'offline';
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ providers }));
        return;
    }

    // ─── Puter Auth Token ────────────────────────────────
    if (req.method === 'GET' && req.url === '/api/puter-token') {
       res.writeHead(403, { 'Content-Type': 'application/json' });
       res.end(JSON.stringify({ error: 'forbidden' }));
       return;
    }

    if (req.method === 'POST' && req.url === '/api/puter-token') {
        let body = '';
        req.on('data', d => { body += d; if (body.length > MAX_BODY_CHARS) rejectBigBody(req, res); });
        req.on('end', () => {
            try {
                const { token } = JSON.parse(body);
                const envPath = path.join(__dirname, '.env');
                let envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8') : '';
                if (token) {
                    if (/^PUTER_AUTH_TOKEN=.*/m.test(envContent)) {
                        envContent = envContent.replace(/^PUTER_AUTH_TOKEN=.*/m, `PUTER_AUTH_TOKEN=${token}`);
                    } else {
                        envContent = envContent.trimEnd() + `\nPUTER_AUTH_TOKEN=${token}\n`;
                    }
                    process.env.PUTER_AUTH_TOKEN = token;
                } else {
                    envContent = envContent.replace(/^PUTER_AUTH_TOKEN=.*\n?/m, '');
                    delete process.env.PUTER_AUTH_TOKEN;
                }
                fs.writeFileSync(envPath, envContent, 'utf-8');
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true }));
            } catch(e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    // ═══════════════════════════════════════════════════════
    // ANALYZE ALL PAGES ENDPOINT
    // ═══════════════════════════════════════════════════════
    if (req.method === 'POST' && req.url === '/api/analyze') {
        if (!checkRateLimit(clientIP, 30, 60000)) {
            res.writeHead(429, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Rate limited. Try again in 60 seconds.' } }));
            return;
        }
        let body = '';
        req.on('data', c => { body += c; if (body.length > MAX_BODY_CHARS) rejectBigBody(req, res); });
        req.on('end', async () => {
            try {
                const p = JSON.parse(body);
                const query = p.query;
                console.log(`[Analyze] Analyzing all pages for: "${query}"`);

                const keyObj = keyPool.getKey('serpapi');
                if (!keyObj) {
                    res.writeHead(503, {'Content-Type': 'application/json'});
                    res.end(JSON.stringify({ error: 'SerpAPI key not available' }));
                    return;
                }

                const analysis = await analyzeAllPages(keyObj, query);

                let analysisOutput = `# 📊 Comprehensive Analysis for: "${query}"\n\n`;
                analysisOutput += `## 📈 Statistics\n`;
                analysisOutput += `- **Pages Analyzed**: ${analysis.totalPages}\n`;

                let totalShoppingResults = 0, totalOrganicResults = 0;
                analysis.results.forEach(result => {
                    totalShoppingResults += result.shopping_results?.length || 0;
                    totalOrganicResults += result.organic_results?.length || 0;
                });
                analysisOutput += `- **Total Products Found**: ${totalShoppingResults}\n`;
                analysisOutput += `- **Total Web Results**: ${totalOrganicResults}\n\n`;

                if (analysis.totalPages === 1) {
                    analysisOutput += `> **Note**: Only 1 page of results was available. Try a more specific search term.\n\n`;
                }

                let allProducts = [];
                analysis.results.forEach((result, pageIdx) => {
                    if (result.shopping_results) {
                        result.shopping_results.forEach(product => {
                            allProducts.push({ ...product, page: pageIdx + 1 });
                        });
                    }
                });

                if (allProducts.length > 0) {
                    analysisOutput += `## 🛒 Complete Product Analysis (${allProducts.length} items)\n\n`;
                    const sortedByPrice = [...allProducts].sort((a, b) => (parseFloat(a.extracted_price) || Infinity) - (parseFloat(b.extracted_price) || Infinity));
                    analysisOutput += `### 💰 Price Range\n`;
                    if (sortedByPrice.length > 0) {
                        const cheapest = sortedByPrice[0];
                        const mostExpensive = sortedByPrice[sortedByPrice.length - 1];
                        analysisOutput += `- **Cheapest**: ${cheapest.title} - ${cheapest.price}\n`;
                        analysisOutput += `- **Most Expensive**: ${mostExpensive.title} - ${mostExpensive.price}\n`;
                        const avgPrice = sortedByPrice.reduce((sum, p) => sum + (parseFloat(p.extracted_price) || 0), 0) / sortedByPrice.length;
                        analysisOutput += `- **Average Price**: $${avgPrice.toFixed(2)}\n\n`;
                    }
                }

                keyPool.releaseKey(keyObj);

                res.writeHead(200, {'Content-Type': 'application/json'});
                res.end(JSON.stringify({
                    choices: [{
                        message: {
                            content: analysisOutput,
                            provider: 'SerpAPI Multi-Page Analyzer',
                            totalPages: analysis.totalPages,
                            totalResults: allProducts.length
                        }
                    }]
                }));
            } catch (e) {
                if (!ended && !res.headersSent) {
                    res.writeHead(500, {'Content-Type': 'application/json'});
                    res.end(JSON.stringify({ error: e.message }));
                }
            }
        });
        return;
    }

    // ═══════════════════════════════════════════════════════
    // YOUTUBE SEARCH ENDPOINT
    // ═══════════════════════════════════════════════════════
        if (req.method === 'GET' && req.url.startsWith('/api/yt-proxy')) {
        const _p = new URL(req.url, `http://localhost:${PORT}`);
        const _type = _p.searchParams.get('type');
        const _cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
        try {
            if (_type === 'oembed') {
                const _vid = _p.searchParams.get('videoId') || '';
                const _oUrl = 'https://www.youtube.com/oembed?url=' +
                    encodeURIComponent('https://www.youtube.com/watch?v=' + _vid) + '&format=json';
                const _or = await fetch(_oUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
                const _od = await _or.json();
                res.writeHead(_or.status, _cors);
                res.end(JSON.stringify(_od));
            } else if (_type === 'rss') {
                const _chId = _p.searchParams.get('channelId') || '';
                const _rUrl = 'https://www.youtube.com/feeds/videos.xml?channel_id=' + encodeURIComponent(_chId);
                const _rr = await fetch(_rUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
                const _xml = await _rr.text();
                res.writeHead(_rr.status, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'text/xml' });
                res.end(_xml);
            } else {
                res.writeHead(400, _cors);
                res.end(JSON.stringify({ error: 'Unknown proxy type' }));
            }
        } catch (_pe) {
            res.writeHead(502, _cors);
            res.end(JSON.stringify({ error: _pe.message }));
        }
        return;
    }
    if (req.method === 'GET' && req.url.startsWith('/api/youtube/search')) {
        const urlParams = new URL(req.url, `http://localhost:${PORT}`).searchParams;
        const query = urlParams.get('q');
        const sortBy = urlParams.get('sort') || 'relevance';
        const duration = urlParams.get('duration') || 'any';
        const maxResults = Math.min(500, Math.max(10, parseInt(urlParams.get('max')) || 30));
        const offset = Math.max(0, parseInt(urlParams.get('offset')) || 0);
        const region = urlParams.get('region') || 'US';
        const expand = urlParams.get('expand') === 'true';

        if (!query) {
            res.writeHead(400, {'Content-Type': 'application/json'});
            res.end(JSON.stringify({ error: 'Missing search query' }));
            return;
        }

        console.log(`[YT Search] "${query}" | region:${region} | expand:${expand}`);

        const fetchYouTubeDL = async () => {
            const YTAPI = 'https://www.youtube.com/youtubei/v1/search?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
            const ctx = { client: { clientName: 'WEB', clientVersion: '2.20231121.08.00', hl: 'en', gl: region } };
            const parseDur = (s) => {
                if (!s) return 0;
                const p = s.split(':').map(Number);
                return p.length === 3 ? p[0]*3600+p[1]*60+p[2] : p.length === 2 ? p[0]*60+p[1] : 0;
            };
            const parseVid = (v) => {
                if (!v?.videoId) return null;
                const durRaw = v.lengthText?.simpleText || '';
                const durationSec = parseDur(durRaw);
                if (duration === 'short' && durationSec > 240) return null;
                if (duration === 'medium' && (durationSec < 240 || durationSec > 1200)) return null;
                if (duration === 'long' && durationSec <= 1200) return null;
                const viewRaw = v.viewCountText?.simpleText || '';
                const vc = parseInt(viewRaw.replace(/[^0-9]/g, '')) || 0;
                const viewsStr = vc > 1000000 ? `${(vc/1000000).toFixed(1)}M` : vc > 1000 ? `${(vc/1000).toFixed(1)}K` : vc > 0 ? String(vc) : null;
                const thumbs = v.thumbnail?.thumbnails || [];
                const thumb = thumbs.find(t => t.width >= 320) || thumbs[thumbs.length - 1];
                return {
                    id: v.videoId, title: v.title?.runs?.[0]?.text || 'Unknown',
                    duration: durRaw || null, durationSec, views: viewsStr, viewCount: vc,
                    uploader: v.ownerText?.runs?.[0]?.text || 'Unknown',
                    type: durationSec > 0 && durationSec <= 60 ? 'short' : 'video', source: 'YouTube',
                    thumbnail: thumb?.url || `https://i.ytimg.com/vi/${v.videoId}/mqdefault.jpg`
                };
            };
            const extractVids = (items) => items.filter(x => x.videoRenderer).map(x => parseVid(x.videoRenderer)).filter(Boolean);
            const getToken = (arr) => { for (const x of arr) { const t = x?.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token; if (t) return t; } return null; };
            try {
                const videos = []; const seen = new Set(); const t0 = Date.now();
                const c1 = new AbortController(); const ti = setTimeout(() => c1.abort(), 12000);
                const r1 = await fetch(YTAPI, { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' }, body: JSON.stringify({ context: ctx, query }), signal: c1.signal });
                clearTimeout(ti);
                if (!r1.ok) { console.log(`[YT Search] Innertube HTTP ${r1.status}`); return []; }
                const d1 = await r1.json();
                const sl = d1?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents || [];
                extractVids(sl.find(c => c.itemSectionRenderer)?.itemSectionRenderer?.contents || []).forEach(v => { if (!seen.has(v.id)) { seen.add(v.id); videos.push(v); } });
                let token = getToken(sl);
                while (token && videos.length < offset + maxResults && Date.now() - t0 < 28000) {
                    try {
                        const c2 = new AbortController(); const t2 = setTimeout(() => c2.abort(), 8000);
                        const r2 = await fetch(YTAPI, { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' }, body: JSON.stringify({ context: ctx, continuation: token }), signal: c2.signal });
                        clearTimeout(t2);
                        if (!r2.ok) break;
                        const d2 = await r2.json();
                        const ci = d2?.onResponseReceivedCommands?.[0]?.appendContinuationItemsAction?.continuationItems || [];
                        extractVids(ci.find(c => c.itemSectionRenderer)?.itemSectionRenderer?.contents || []).forEach(v => { if (!seen.has(v.id)) { seen.add(v.id); videos.push(v); } });
                        token = getToken(ci);
                    } catch { break; }
                }
                if (sortBy === 'views') videos.sort((a, b) => b.viewCount - a.viewCount);
                console.log(`[YT Search] Innertube returned ${videos.length} results (req: ${maxResults})`);
                return videos;
            } catch (e) {
                console.log('[YT Search] Innertube failed:', e.message?.substring(0, 60));
                return [];
            }
        };

        const fetchGoogleCSE = async () => {
            if (!expand) return [];
            const keyObj = keyPool.getKey('google_cse');
            if (!keyObj) return [];
            try {
                const cseUrl = new URL(keyObj.endpoint);
                cseUrl.searchParams.append('key', keyObj.key);
                cseUrl.searchParams.append('cx', keyObj.cx);
                cseUrl.searchParams.append('q', `site:youtube.com ${query}`);
                cseUrl.searchParams.append('num', '10');
                cseUrl.searchParams.append('gl', region.toLowerCase());
                const cseRes = await fetch(cseUrl.toString(), { headers: { "User-Agent": "AI-Assistant/1.0" } });
                keyPool.releaseKey(keyObj);
                if (!cseRes.ok) return [];
                const data = await cseRes.json();
                return (data.items || []).map(item => {
                    const match = item.link.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
                    if (match) {
                        return {
                            id: match[1], title: item.title, duration: null, durationSec: 0,
                            views: null, uploader: item.displayLink || 'Google', type: 'video',
                            source: 'Google', thumbnail: `https://i.ytimg.com/vi/${match[1]}/mqdefault.jpg`
                        };
                    }
                    return null;
                }).filter(Boolean);
            } catch (e) {
                if (keyObj) keyPool.releaseKey(keyObj, e);
                return [];
            }
        };

        try {
            // Try yt-dlp first (most reliable on Termux)
            let ytResults = await fetchYouTubeDL();
            
            // If yt-dlp returns few results and expand is true, also try Google CSE
            let googleResults = [];
            if (expand && ytResults.length < 5) {
                googleResults = await fetchGoogleCSE();
            }
            
            const seenIds = new Set();
            const mergedVideos = [];
            [...ytResults, ...googleResults].forEach(video => {
                if (video && video.id && !seenIds.has(video.id)) { 
                    seenIds.add(video.id); 
                    mergedVideos.push(video); 
                }
            });
            
            // Apply sorting
            if (sortBy === 'views') {
                mergedVideos.sort((a, b) => (b.viewCount || 0) - (a.viewCount || 0));
            }
            
            const finalResults = mergedVideos.slice(offset, offset + maxResults);
            const hasMore = mergedVideos.length > offset + maxResults;
            console.log(`[YT Search] Found ${finalResults.length} videos (offset:${offset}, yt-dlp: ${ytResults.length}, Google: ${googleResults.length})`);
            res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end(JSON.stringify({ videos: finalResults, query, total: finalResults.length, hasMore, offset }));
        } catch (e) {
            console.error('[YT Search] Error:', e);
            res.writeHead(500, {'Content-Type': 'application/json'});
            res.end(JSON.stringify({ error: e.message, videos: [] }));
        }
        return;
    }

    // ═══════════════════════════════════════════════════════
    // WORD TRANSLATION ENDPOINT
    // ═══════════════════════════════════════════════════════
    if (req.method === 'GET' && req.url.startsWith('/api/translate-word')) {
            const urlParams = new URL(req.url, `http://localhost:${PORT}`).searchParams;
            const word = urlParams.get('word');

            if (!word) {
                res.writeHead(400, {'Content-Type': 'application/json'});
                res.end(JSON.stringify({ error: 'Missing word' }));
                return;
            }

            console.log(`[Translate] "${word}" → cascade`);

            const prompt =
`Translate the English word "${word}" into these languages.
Return ONLY a raw JSON object. No markdown. No backticks. No explanation.

{"word":"${word}","translations":[{"code":"ar","text":"Arabic translation","romanization":"pronunciation"},{"code":"es","text":"Spanish","romanization":""},{"code":"fr","text":"French","romanization":""},{"code":"de","text":"German","romanization":""},{"code":"zh","text":"Chinese","romanization":"pinyin"},{"code":"ja","text":"Japanese","romanization":"romaji"},{"code":"ko","text":"Korean","romanization":"romanized"},{"code":"tr","text":"Turkish","romanization":""},{"code":"ru","text":"Russian","romanization":"romanized"},{"code":"pt","text":"Portuguese","romanization":""},{"code":"it","text":"Italian","romanization":""}]}`;

            // ── Try GitHub AI first, then fall back to server-side keys ──
            const tryGitHubWithRetry = async () => {
                for (let attempt = 0; attempt < GITHUB_AI_KEYS.length; attempt++) {
                    try {
                        const content = await callGitHubAI(prompt, 700);
                        return content;
                    } catch (e) {
                        if (e.message?.includes('429')) {
                            console.log(`[Translate] GitHub AI key ${attempt + 1} rate limited, trying next...`);
                            await new Promise(r => setTimeout(r, 500));
                            continue;
                        }
                        throw e;
                    }
                }
                throw new Error('All GitHub AI keys rate limited');
            };

            const parseTranslationContent = (content) => {
                let cleaned = content
                    .replace(/```json\s*/gi, '')
                    .replace(/```\s*/g, '')
                    .trim();
                const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
                if (!jsonMatch) return null;
                try {
                    return JSON.parse(jsonMatch[0]);
                } catch (e) {
                    const repaired = jsonMatch[0]
                        .replace(/,\s*}/g, '}')
                        .replace(/,\s*]/g, ']');
                    try { return JSON.parse(repaired); } catch (_) { return null; }
                }
            };

            try {
                let result = null;

                // Try GitHub AI
                try {
                    const content = await tryGitHubWithRetry();
                    result = parseTranslationContent(content);
                    if (result) {
                        res.writeHead(200, {'Content-Type': 'application/json'});
                        res.end(JSON.stringify(result));
                        return;
                    }
                } catch (ghErr) {
                    console.log(`[Translate] GitHub AI failed: ${ghErr.message}`);
                }

                // Fall back to server-side providers
                const fallbackProviders = [
                    'chatanywhere',
                    'sambanova-deepseek',
                    'sambanova-gptoss',
                    'pawan'
                ];

                for (const providerName of fallbackProviders) {
                    const keyObj = keyPool.getKey(providerName);
                    if (!keyObj) continue;
                    try {
                        const data = await callAPI(keyObj, [{ role: 'user', content: prompt }], 600);
                        keyPool.releaseKey(keyObj);
                        const c = data.choices?.[0]?.message?.content || '';
                        result = parseTranslationContent(c);
                        if (result) {
                            res.writeHead(200, {'Content-Type': 'application/json'});
                            res.end(JSON.stringify(result));
                            return;
                        }
                    } catch (e) {
                        keyPool.releaseKey(keyObj, e);
                        console.log(`[Translate] ${providerName} failed: ${e.message?.substring(0, 50)}`);
                    }
                }

                throw new Error('No provider returned valid JSON');

            } catch (err) {
                console.error('[Translate] All providers failed:', err.message);
                res.writeHead(200, {'Content-Type': 'application/json'});
                res.end(JSON.stringify({
                    word,
                    translations: [
                        { code: 'ar', text: '—', romanization: '' },
                        { code: 'de', text: '—', romanization: '' },
                        { code: 'fr', text: '—', romanization: '' },
                        { code: 'es', text: '—', romanization: '' }
                    ]
                }));
            }
            return;
    }
    
    if (req.method === 'POST' && req.url === '/api/caption-classify') {
        if (!checkRateLimit(clientIP, 20, 60000)) {
            res.writeHead(429, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Rate limited' }));
            return;
        }

        let body = '';
        let bodySize = 0;

        req.on('data', chunk => {
            bodySize += chunk.length;

            if (bodySize > 1024 * 1024) {
                res.writeHead(413, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Request body too large' }));
                req.destroy();
                return;
            }

            body += chunk;
        });

        req.on('end', async () => {
            let keyObj = null;

            try {
                const parsed = JSON.parse(body);
                const prompt = String(parsed.prompt || '');
                const requestedProvider = String(parsed.provider || '');

                const provider = [
                    'sambanova-deepseek',
                    'openrouter-deepseek',
                    'deepseek'
                ].includes(requestedProvider)
                    ? requestedProvider
                    : 'sambanova-deepseek';

                if (!prompt) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'prompt is required' }));
                    return;
                }

                keyObj =
                    keyPool.getKey(provider) ||
                    keyPool.getKey('sambanova-deepseek') ||
                    keyPool.getKey('openrouter-deepseek');

                if (!keyObj) {
                    res.writeHead(503, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Caption AI unavailable' }));
                    return;
                }

                const result = await callAPI(
                    keyObj,
                    [{ role: 'user', content: prompt }],
                    2400
                );

                const content =
                    result?.choices?.[0]?.message?.content || '';

                if (!content) {
                    throw new Error('Caption classifier returned empty content');
                }

                res.writeHead(200, {
                    'Content-Type': 'application/json'
                });

                res.end(JSON.stringify({ content }));
            } catch (error) {
                if (!res.headersSent) {
                    res.writeHead(500, {
                        'Content-Type': 'application/json'
                    });

                    res.end(JSON.stringify({
                        error: error.message
                    }));
                }
            } finally {
                if (keyObj) {
                    keyPool.releaseKey(keyObj);
                }
            }
        });

        return;
    }
    // ═══════════════════════════════════════════════════════
    // CONTEXT-AWARE CAPTION ANALYSIS
    // ═══════════════════════════════════════════════════════
    if (req.method === 'POST' && req.url === '/api/caption-analyze') {
        if (!checkRateLimit(clientIP, 30, 60000)) {
            res.writeHead(429, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Rate limited. Try again in 60 seconds.' } }));
            return;
        }
        let body = '';
        let bodySize = 0;
        const MAX_BODY = 1024 * 1024; // 1MB limit
        req.on('data', c => {
            bodySize += c.length;
            if (bodySize > MAX_BODY) {
                res.writeHead(413, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'Request body too large' } }));
                req.destroy();
                return;
            }
            body += c;
        });
        req.on('end', async () => {
            try {
                const { lines, targetLang = 'ar' } = JSON.parse(body);
                let keyObj = keyPool.getKey('sambanova-deepseek')
                            || keyPool.getKey('sambanova-gptoss')
                            || keyPool.getKey('pawan');
                if (!keyObj) {
                    res.writeHead(503, {'Content-Type': 'application/json'});
                    res.end(JSON.stringify({ error: 'AI unavailable' }));
                    return;
                }

                const context = lines.map((l, i) => `[${i + 1}] ${l}`).join('\n');
                const focusLine = lines[Math.floor(lines.length / 2)];
                const langName = { ar: 'Arabic', de: 'German', fr: 'French', es: 'Spanish' }[targetLang] || targetLang;

                const prompt = `You are an English language teacher analyzing captions from a video.

Caption context (the focused line is in the middle):
 ${context}

Analyze ONLY the focused line: "${focusLine}"
Use the surrounding lines to understand its meaning in context.

Return ONLY valid JSON:
{
  "translation": "${langName} translation of the focused line",
  "contextMeaning": "1-2 sentences: what this line means in context",
  "keyPhrases": [{ "phrase": "important phrase", "meaning": "what it means here" }],
  "commonErrors": [{ "error": "mistake learners make", "correction": "correct form", "example": "example sentence" }],
  "grammarNote": "one grammar point worth learning, or empty string"
}`;

                const data = await callAPI(keyObj, [{ role: 'user', content: prompt }], 600);
                keyPool.releaseKey(keyObj);

                const content = data.choices?.[0]?.message?.content || '';
                const stripped = content.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
                const jsonMatch = stripped.match(/\{[\s\S]*?\}/s);
                if (jsonMatch) {
                    try {
                        JSON.parse(jsonMatch[0]); // validate
                        res.writeHead(200, {'Content-Type': 'application/json'});
                        res.end(jsonMatch[0]);
                        return;
                    } catch(e) {}
                }
                throw new Error('No JSON in response');
            } catch (e) {
                if (!ended && !res.headersSent) {
                    res.writeHead(500, {'Content-Type': 'application/json'});
                    res.end(JSON.stringify({ error: e.message }));
                }
            }
        });
        return;
    }

    // ═══════════════════════════════════════════════════════
    // BATCH CAPTION TRANSLATION
    // ═══════════════════════════════════════════════════════
    if (req.method === 'POST' && req.url === '/api/translate-batch') {
        if (!checkRateLimit(clientIP, 30, 60000)) {
            res.writeHead(429, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Rate limited. Try again in 60 seconds.' } }));
            return;
        }
        let body = '';
        req.on('data', c => { body += c; if (body.length > MAX_BODY_CHARS) rejectBigBody(req, res); });
        req.on('end', async () => {
            try {
                const { lines, targetLang = 'ar', dialect = 'egyptian' } = JSON.parse(body);
                if (!Array.isArray(lines) || lines.length === 0) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Missing lines array' }));
                    return;
                }

                const arDialectNotes = {
                    msa:       'Modern Standard Arabic (فصحى).',
                    egyptian:  'Egyptian Arabic (عامية مصرية). Use: إيه، ده، دي، مش، عايز، أوي، كده، معلش، يلا.',
                    gulf:      'Gulf Arabic (خليجي). Use: وش، شلون، ليش، حق، زين، وايد.',
                    levantine: 'Levantine Arabic (شامي). Use: شو، هيك، كتير، بدي، هلق، رح، منيح.',
                    moroccan:  'Moroccan Darija (دارجة). Use: واش، ديال، كاين، غادي، بزاف، كيفاش.'
                };

                const dialectNote = arDialectNotes[dialect] || arDialectNotes.egyptian;
                const langName = { ar: 'Arabic', de: 'German', fr: 'French', es: 'Spanish' }[targetLang] || targetLang;

                const sanitizedLines = lines.map(l =>
                    l.replace(/[\x00-\x1F\x7F]/g, ' ')
                     .replace(/"/g, "'")
                     .trim()
                );
                
                const prompt =
`Translate each English caption line to ${langName} independently.
${targetLang === 'ar' ? 'Dialect: ' + dialectNote : ''}

STRICT RULES:
1. Output EXACTLY ${lines.length} lines, one per source line, in order
2. Format each line as:  NUMBER|||TRANSLATION
3. Each source line gets its OWN separate translation — never merge two lines
4. [Music] [Applause] [sound tags] → NUMBER|||-
5. Numbers or timestamps → copy unchanged: NUMBER|||original
6. NO JSON, NO markdown, ONLY pipe-delimited lines

Source lines:
${sanitizedLines.map((l, i) => `${i}|||${l}`).join('\n')}

Translated lines:`;

                // ── Provider cascade: try 3 providers before giving up ──
                const providerOrder = [
                    'chatanywhere',   // GPT-4o-mini, fast & reliable
                    'chatanywhere1',  // second ChatAnywhere key
                    'sambanova-deepseek',
                    'sambanova-gptoss',
                    'openrouter-deepseek',
                    'pawan'
                ];

                let data = null;
                let usedKey = null;

                for (const providerName of providerOrder) {
                    const keyObj = keyPool.getKey(providerName);
                    if (!keyObj) continue;
                    try {
                        console.log(`[Batch Translate] Trying ${providerName}...`);
                        data = await callAPI(keyObj, [{ role: 'user', content: prompt }], lines.length * 80);
                        keyPool.releaseKey(keyObj);
                        usedKey = providerName;
                        break;
                    } catch (e) {
                        keyPool.releaseKey(keyObj, e);
                        console.log(`[Batch Translate] ${providerName} failed: ${e.message?.substring(0, 60)}`);
                    }
                }

                if (!data) {
                    res.writeHead(503, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'All translation providers busy or failed' }));
                    return;
                }

                const content = data.choices?.[0]?.message?.content || '';
                console.log(`[Batch Translate] Raw response (${usedKey}): ${content.substring(0, 120)}`);

                // ── Parse pipe-delimited output ──
                const lineResults = new Array(lines.length).fill('—');
                const rawLines = content.split('\n');

                for (const rawLine of rawLines) {
                    const trimmed = rawLine.trim();
                    if (!trimmed) continue;
                    const pipeIdx = trimmed.indexOf('|||');
                    if (pipeIdx === -1) continue;
                    const numStr = trimmed.slice(0, pipeIdx).trim().replace(/[^0-9]/g, '');
                    const translation = trimmed.slice(pipeIdx + 3).trim();
                    const idx = parseInt(numStr, 10);
                    if (!isNaN(idx) && idx >= 0 && idx < lines.length && translation) {
                        lineResults[idx] = translation;
                    }
                }

                // Fallback: if pipe parsing got fewer than 60%, try JSON
                const pipeFilledCount = lineResults.filter(r => r !== '—').length;
                if (pipeFilledCount < Math.ceil(lines.length * 0.6)) {
                    console.log(`[Batch Translate] Pipe parsing only got ${pipeFilledCount}/${lines.length}, trying JSON fallback`);
                    let objResult = null;
                    const stripped = content.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
                    const jsonMatch = stripped.match(/\{[\s\S]*\}/);
                    if (jsonMatch) {
                        try { objResult = JSON.parse(jsonMatch[0]); }
                        catch (e) {
                            try {
                                objResult = JSON.parse(
                                    jsonMatch[0].replace(/,\s*}/g, '}').replace(/,\s*]/g, ']')
                                               .replace(/([{,]\s*)(\w+)\s*:/g, '$1"$2":')
                                               .replace(/:\s*'([^']*)'/g, ': "$1"')
                                );
                            } catch (_) {}
                        }
                    }
                    if (objResult) {
                        for (let i = 0; i < lines.length; i++) {
                            const v = objResult[`L${i}`] || objResult[String(i)] || objResult[i];
                            if (v) lineResults[i] = String(v).trim();
                        }
                    }
                }

                const validCount = lineResults.filter(t => t !== '—').length;
                console.log(`[Batch Translate] ✅ ${validCount}/${lines.length} lines translated via ${usedKey}`);

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ translations: lineResults }));

            } catch (e) {
                console.error('[Batch Translate] Fatal error:', e.message);
                if (!ended && !res.headersSent) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: e.message }));
                }
            }
        });
        return;
    }

    // ═══════════════════════════════════════════════════════
    // CODE EDITOR AI ENDPOINT
    // ═══════════════════════════════════════════════════════
    if (req.method === 'POST' && req.url === '/api/code-assist') {
        let body = '';
        req.on('data', c => { body += c; if (body.length > MAX_BODY_CHARS) rejectBigBody(req, res); });
        req.on('end', async () => {
            try {
                const { code, language, type, prompt } = JSON.parse(body);
                let keyObj;
                if (type === 'autocomplete') { keyObj = keyPool.getKey('chatanywhere') || keyPool.getKey('pawan'); }
                else { keyObj = keyPool.getKey('sambanova') || keyPool.getKey('pawan'); }

                if (!keyObj) {
                    res.writeHead(503, {'Content-Type': 'application/json'});
                    res.end(JSON.stringify({ error: 'AI providers busy' }));
                    return;
                }

                let systemPrompt = "";
                let maxTokens = 200;
                if (type === 'autocomplete') { systemPrompt = `You are an intelligent code autocomplete engine. Continue the code logically. Return ONLY the code to append, no explanations or markdown.`; maxTokens = 150; }
                else if (type === 'analyze') { systemPrompt = `You are a senior code reviewer and debugger. Analyze the provided ${language} code. Identify errors, bugs, and potential improvements. Return your analysis in Markdown format.`; maxTokens = 2000; }
                else if (type === 'fix') { systemPrompt = `You are an automated code fixer. Fix the errors in the provided ${language} code. Return ONLY the complete corrected code inside a markdown code block, followed by a brief list of changes.`; maxTokens = 3000; }

                const data = await callAPI(keyObj, [{ role: "system", content: systemPrompt }, { role: "user", content: prompt || code }], maxTokens);
                keyPool.releaseKey(keyObj);
                res.writeHead(200, {'Content-Type': 'application/json'});
                res.end(JSON.stringify({ suggestion: data.choices?.[0]?.message?.content || '' }));
            } catch (e) {
                if (!ended && !res.headersSent) {
                    res.writeHead(500, {'Content-Type': 'application/json'});
                    res.end(JSON.stringify({ error: e.message }));
                }
            }
        });
        return;
    }

    // ═══════════════════════════════════════════════════════
    // SERVE CODE EDITOR STATIC FILES
    // ═══════════════════════════════════════════════════════
    if (req.method === 'GET' && req.url.startsWith('/editor')) {
        const filePath = req.url === '/editor' ? '/code-editor/index.html' : req.url;
        const fullPath = path.join(__dirname, filePath);
        try {
            if (fs.existsSync(fullPath)) {
                const ext = path.extname(fullPath);
                const contentTypes = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript' };
                res.writeHead(200, {'Content-Type': contentTypes[ext] || 'text/plain'});
                res.end(fs.readFileSync(fullPath, 'utf-8'));
            } else { res.writeHead(404); res.end('Editor file not found'); }
        } catch (e) { res.writeHead(500); res.end('Error loading editor'); }
        return;
    }
    
    // ═══════════════════════════════════════════════════════
    // UNIVERSAL CODE EXECUTOR — supports multiple languages
    // ═══════════════════════════════════════════════════════
    if (req.method === 'POST' && req.url === '/api/run-code') {
        if (!process.env.ALLOW_CODE_EXEC) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'disabled' }));
            return;
        }
        let body = '';
        req.on('data', c => { body += c; if (body.length > MAX_BODY_CHARS) rejectBigBody(req, res); });
        req.on('end', async () => {
            try {
                const { code, language, compiled = false } = JSON.parse(body);
                if (!code || code.length > 100000) {
                    res.writeHead(400, {'Content-Type': 'application/json'});
                    res.end(JSON.stringify({ error: 'Missing or oversized code' }));
                    return;
                }

                const execMap = {
                    // Interpreted languages
                    python:   { cmd: 'python3',    file: 'script.py',    ext: 'py' },
                    ruby:     { cmd: 'ruby',       file: 'script.rb',    ext: 'rb' },
                    php:      { cmd: 'php',        file: 'script.php',   ext: 'php' },
                    perl:     { cmd: 'perl',       file: 'script.pl',    ext: 'pl' },
                    lua:      { cmd: 'lua',        file: 'script.lua',   ext: 'lua' },
                    r:        { cmd: 'Rscript',    file: 'script.R',     ext: 'r' },
                    node:     { cmd: 'node',       file: 'script.js',    ext: 'js' },
                    javascript:{ cmd: 'node',      file: 'script.js',    ext: 'js' },
                    js:       { cmd: 'node',       file: 'script.js',    ext: 'js' },
                    bash:     { cmd: 'bash',       file: 'script.sh',    ext: 'sh' },
                    sh:       { cmd: 'bash',       file: 'script.sh',    ext: 'sh' },
                    
                    // Compiled languages
                    java:     { cmd: 'javac',      run: 'java',          file: 'Main.java',   main: 'Main',        ext: 'java' },
                    cpp:      { cmd: 'g++',        run: './a.out',       file: 'code.cpp',    needsCompile: true,  ext: 'cpp' },
                    c:        { cmd: 'gcc',        run: './a.out',       file: 'code.c',      needsCompile: true,  ext: 'c' },
                    csharp:   { cmd: 'mcs',        run: 'mono',          file: 'code.cs',     runFile: 'code.exe', ext: 'cs' },
                    cs:       { cmd: 'mcs',        run: 'mono',          file: 'code.cs',     runFile: 'code.exe', ext: 'cs' },
                    go:       { cmd: 'go',         run: 'go run',        file: 'code.go',     needsCompile: false, ext: 'go' },
                    rust:     { cmd: 'rustc',      run: './code',        file: 'code.rs',     needsCompile: true,  ext: 'rs' },
                    swift:    { cmd: 'swiftc',     run: './code',        file: 'code.swift',  needsCompile: true,  ext: 'swift' },
                    kotlin:   { cmd: 'kotlinc',    run: 'kotlin',        file: 'code.kt',     main: 'MainKt',      ext: 'kt' },
                    scala:    { cmd: 'scalac',     run: 'scala',         file: 'code.scala',  main: 'Main',        ext: 'scala' },
                    dart:     { cmd: 'dart',       run: 'dart run',      file: 'code.dart',   needsCompile: false, ext: 'dart' }
                };

                const config = execMap[language.toLowerCase()];
                if (!config) {
                    res.writeHead(400, {'Content-Type': 'application/json'});
                    res.end(JSON.stringify({ 
                        error: `Language "${normalizedLang}" not supported. Supported: ${Object.keys(execMap).join(', ')}` 
                    }));
                    return;
                }

                const tmpId = `code_${Date.now()}_${Math.random().toString(36).slice(2)}`;
                const _execBase2 = (process.env.HOME && fs.existsSync(process.env.HOME))
                    ? process.env.HOME
                    : os.tmpdir();
                const tmpDir = path.join(_execBase2, '.code_runs', tmpId);
                await fs.promises.mkdir(tmpDir, { recursive: true });
                
                const codeFile = path.join(tmpDir, config.file);
                fs.writeFileSync(codeFile, code, 'utf-8');

                let stdout = '', stderr = '';
                let success = false;

                try {
                    // Compiled language handling
                    if (config.needsCompile || config.cmd === 'javac' || config.cmd === 'g++' || 
                        config.cmd === 'gcc' || config.cmd === 'rustc' || config.cmd === 'swiftc' ||
                        config.cmd === 'kotlinc' || config.cmd === 'scalac') {
                        
                        // Step 1: Compile
                        let compileArgs;
                        if (language === 'java') {
                            // javac does NOT use -d; compile into tmpDir implicitly (file is already there)
                            compileArgs = [codeFile];
                        } else if (language === 'cpp' || language === 'c') {
                            compileArgs = [codeFile, '-o', path.join(tmpDir, 'a.out')];
                        } else {
                            compileArgs = ['-d', tmpDir, codeFile];
                        }
                        const { stderr: compileErr } = await execFileAsync(config.cmd, compileArgs, {
                            cwd: tmpDir,
                            timeout: 30000
                        });
                        
                        if (compileErr && compileErr.trim()) {
                            throw new Error(`Compilation error: ${compileErr}`);
                        }
                        
                        // Step 2: Run
                        let runCmd, runArgs;
                        if (language === 'java') {
                            runCmd = 'java';
                            runArgs = ['-cp', tmpDir, 'Main'];
                        } else if (language === 'cpp' || language === 'c') {
                            runCmd = config.run;
                            runArgs = [];
                        } else if (language === 'csharp' || language === 'cs') {
                            const exeFile = path.join(tmpDir, 'code.exe');
                            runCmd = 'mono';
                            runArgs = [exeFile];
                        } else if (language === 'rust') {
                            runCmd = config.run;
                            runArgs = [];
                        } else if (language === 'swift') {
                            runCmd = config.run;
                            runArgs = [];
                        } else if (language === 'kotlin') {
                            runCmd = 'kotlin';
                            runArgs = ['-cp', tmpDir, config.main];
                        } else if (language === 'scala') {
                            runCmd = 'scala';
                            runArgs = ['-cp', tmpDir, config.main];
                        } else {
                            runCmd = config.run;
                            runArgs = [];
                        }
                        
                        const { stdout: runOut, stderr: runErr } = await execFileAsync(runCmd, runArgs, {
                            cwd: tmpDir,
                            timeout: 15000,
                            maxBuffer: 5 * 1024 * 1024
                        });
                        stdout = runOut;
                        stderr = runErr;
                        success = !runErr || runErr.trim() === '';
                        
                    } else if (config.cmd === 'go') {
                        // Go run
                        const { stdout: goOut, stderr: goErr } = await execFileAsync('go', ['run', codeFile], {
                            cwd: tmpDir,
                            timeout: 15000
                        });
                        stdout = goOut;
                        stderr = goErr;
                        success = !goErr || goErr.trim() === '';
                        
                    } else if (config.cmd === 'dart') {
                        // Dart run
                        const { stdout: dartOut, stderr: dartErr } = await execFileAsync('dart', ['run', codeFile], {
                            cwd: tmpDir,
                            timeout: 15000
                        });
                        stdout = dartOut;
                        stderr = dartErr;
                        success = !dartErr || dartErr.trim() === '';
                        
                    } else {
                        // Interpreted languages (python, ruby, php, node, bash, etc.)
                        const { stdout: runOut, stderr: runErr } = await execFileAsync(config.cmd, [codeFile], {
                            cwd: tmpDir,
                            timeout: 15000,
                            maxBuffer: 5 * 1024 * 1024,
                            env: {
                                ...process.env,
                                PYTHONDONTWRITEBYTECODE: '1',
                                NODE_NO_WARNINGS: '1'
                            }
                        });
                        stdout = runOut;
                        stderr = runErr;
                        success = !runErr || runErr.trim() === '';
                    }

                    // Clean up
                    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch(_) {}
                    
                    res.writeHead(200, {'Content-Type': 'application/json'});
                    res.end(JSON.stringify({ stdout, stderr, success }));

                } catch (execErr) {
                    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch(_) {}
                    res.writeHead(200, {'Content-Type': 'application/json'});
                    res.end(JSON.stringify({ 
                        stdout: '', 
                        stderr: execErr.message || 'Execution failed', 
                        success: false 
                    }));
                }

            } catch (e) {
                if (!res.headersSent) {
                    res.writeHead(500, {'Content-Type': 'application/json'});
                    res.end(JSON.stringify({ error: e.message }));
                }
            }
        });
        return;
    }
    
    // ═══════════════════════════════════════════════════════
    // GET SUPPORTED LANGUAGES
    // ═══════════════════════════════════════════════════════
    if (req.method === 'GET' && req.url === '/api/languages') {
        const languages = [
            { id: 'python', name: 'Python', icon: '🐍', compiled: false, installed: true },
            { id: 'javascript', name: 'JavaScript (Node.js)', icon: '🟨', compiled: false, installed: true },
            { id: 'java', name: 'Java', icon: '☕', compiled: true, installed: false },
            { id: 'cpp', name: 'C++', icon: '⚙️', compiled: true, installed: false },
            { id: 'c', name: 'C', icon: '🔧', compiled: true, installed: false },
            { id: 'go', name: 'Go', icon: '🐹', compiled: false, installed: false },
            { id: 'rust', name: 'Rust', icon: '🦀', compiled: true, installed: false },
            { id: 'ruby', name: 'Ruby', icon: '💎', compiled: false, installed: false },
            { id: 'php', name: 'PHP', icon: '🐘', compiled: false, installed: false },
            { id: 'csharp', name: 'C#', icon: '🎯', compiled: true, installed: false },
            { id: 'swift', name: 'Swift', icon: '🦅', compiled: true, installed: false },
            { id: 'kotlin', name: 'Kotlin', icon: '💜', compiled: true, installed: false },
            { id: 'bash', name: 'Bash', icon: '📟', compiled: false, installed: true },
            { id: 'perl', name: 'Perl', icon: '🐪', compiled: false, installed: false },
            { id: 'lua', name: 'Lua', icon: '🌙', compiled: false, installed: false },
            { id: 'r', name: 'R', icon: '📊', compiled: false, installed: false },
            { id: 'dart', name: 'Dart', icon: '🎯', compiled: false, installed: false }
        ];
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ languages }));
        return;
    }
    
    // ═══════════════════════════════════════════════════════
    // MAIN CHAT API ENDPOINT
    // ═══════════════════════════════════════════════════════
    if (req.method === 'POST' && req.url === '/api') {
        if (!checkRateLimit(clientIP, 30, 60000)) {
            res.writeHead(429, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Rate limited. Try again in 60 seconds.' } }));
            return;
        }
        let body = '';
        req.on('data', c => { body += c; if (body.length > MAX_BODY_CHARS) rejectBigBody(req, res); });
        req.on('end', async () => {
            try {
                const { messages, max_tokens = 4096, provider = 'auto' } = JSON.parse(body);
                
                const CODE_RULES_SYSTEM = {
                    role: 'system',
                    content: `When writing code follow these rules strictly:
JAVA: Always use exactly ONE public class named Main. Never use package declarations. All helper classes in same file as non-public. main() must be public static void main(String[] args). ALWAYS include full generic type parameters — never use raw types. Write List<Integer> not List. Write Optional<String> not Optional. Write Map<String,Object> not Map. Write ArrayList<String> not ArrayList. Every collection or generic class MUST have <T> type parameters.
PYTHON: No broken f-strings. No unclosed quotes across lines. Use print() not print. All imports at top.
ALL LANGUAGES: Write complete runnable code only. No pseudocode. No placeholder comments like //TODO. No markdown in code blocks. Single file only.
COMPLETENESS RULE: You MUST write your ENTIRE response in one continuous pass without stopping. If writing a tutorial, guide, course, or multi-section content, include EVERY section completely — do not skip, summarize, or abbreviate. Never truncate mid-sentence, mid-code-block, or mid-section. Close every code fence you open. Do not stop writing until the response is fully and genuinely complete.
CRITICAL — NEVER STOP EARLY: If you feel you are approaching a token or length limit, do NOT stop. Do NOT write "continue in next message". Do NOT add a closing remark until ALL content is written. The system will automatically request continuation if needed — your only job is to keep writing until everything is complete.`
                };
                
                const hasSystem = messages.length > 0 && messages[0].role === 'system';
                const finalMessages = hasSystem
                    ? [{ ...messages[0], content: messages[0].content + '\n\n' + CODE_RULES_SYSTEM.content }, ...messages.slice(1)]
                    : [CODE_RULES_SYSTEM, ...messages];
                // Deduplicate: ignore identical requests within 800ms
                const reqKey = clientIP + ':' + (messages.at(-1)?.content?.slice(0, 60) ?? '');
                if (global._inflightReqs?.has(reqKey)) {
                    res.writeHead(429, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: { message: 'Duplicate request, please wait.' } }));
                    return;
                }
                if (!global._inflightReqs) global._inflightReqs = new Map();
                global._inflightReqs.set(reqKey, true);
                setTimeout(() => global._inflightReqs?.delete(reqKey), 800);
                if (!messages || !Array.isArray(messages)) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: { message: 'messages array required' } }));
                    return;
                }
                await continuationManager.sendCompleteResponse(finalMessages, res, provider);
            } catch (e) {
                if (!res.headersSent) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: { message: e.message } }));
                }
            }
        });
        return;
    }
    
    // ═══════════════════════════════════════════════════════
    // GNEWS ENDPOINTS
    // ═══════════════════════════════════════════════════════

    // ── GNews Top Headlines ──
    if (req.method === 'GET' && req.url.startsWith('/api/gnews/headlines')) {
        const urlParams = new URL(req.url, `http://localhost:${PORT}`).searchParams;
        const category = urlParams.get('category') || 'technology';
        const lang     = urlParams.get('lang') || 'en';
        const max      = Math.min(50, Math.max(1, parseInt(urlParams.get('max')) || 5));

        const gnewsKey = process.env.GNEWS_KEY;
        if (!gnewsKey) {
            res.writeHead(503, {'Content-Type': 'application/json'});
            res.end(JSON.stringify({ error: 'GNews API key not configured' }));
            return;
        }

        try {
            const gnewsUrl = `https://gnews.io/api/v4/top-headlines?category=${category}&lang=${lang}&max=${max}&apikey=${gnewsKey}`;
            const response = await fetch(gnewsUrl, { headers: { 'User-Agent': 'AI-Assistant/1.0' } });
            const data = await response.json();

            let output = `# 📰 ${category.charAt(0).toUpperCase() + category.slice(1)} Headlines\n\n`;
            if (data.articles && data.articles.length > 0) {
                data.articles.forEach((article, idx) => {
                    output += `### ${idx + 1}. ${article.title}\n`;
                    output += `- **Source**: ${article.source?.name || 'Unknown'}\n`;
                    output += `- **Date**: ${article.publishedAt?.substring(0, 10) || 'N/A'}\n`;
                    if (article.description) output += `- **Summary**: ${article.description}\n`;
                    if (article.url) output += `- [Read Full Article](${article.url})\n`;
                    output += `\n`;
                });
            } else {
                output += 'No headlines found for this category.\n';
            }

            res.writeHead(200, {'Content-Type': 'application/json'});
            res.end(JSON.stringify({
                choices: [{ message: { content: output, provider: 'GNews' }, finish_reason: 'stop' }]
            }));
        } catch (e) {
            res.writeHead(500, {'Content-Type': 'application/json'});
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    // ── GNews Search ──
    if (req.method === 'GET' && req.url.startsWith('/api/gnews/search')) {
        const urlParams = new URL(req.url, `http://localhost:${PORT}`).searchParams;
        const query = urlParams.get('q');
        const lang  = urlParams.get('lang') || 'en';
        const max   = Math.min(50, Math.max(1, parseInt(urlParams.get('max')) || 5));

        if (!query) {
            res.writeHead(400, {'Content-Type': 'application/json'});
            res.end(JSON.stringify({ error: 'Missing query parameter q' }));
            return;
        }

        const gnewsKey = process.env.GNEWS_KEY;
        if (!gnewsKey) {
            res.writeHead(503, {'Content-Type': 'application/json'});
            res.end(JSON.stringify({ error: 'GNews API key not configured' }));
            return;
        }

        try {
            const gnewsUrl = `https://gnews.io/api/v4/search?q=${encodeURIComponent(query)}&lang=${lang}&max=${max}&apikey=${gnewsKey}`;
            const response = await fetch(gnewsUrl, { headers: { 'User-Agent': 'AI-Assistant/1.0' } });
            const data = await response.json();

            let output = `# 📰 News Search: "${query}"\n\n`;
            if (data.articles && data.articles.length > 0) {
                data.articles.forEach((article, idx) => {
                    output += `### ${idx + 1}. ${article.title}\n`;
                    output += `- **Source**: ${article.source?.name || 'Unknown'}\n`;
                    output += `- **Date**: ${article.publishedAt?.substring(0, 10) || 'N/A'}\n`;
                    if (article.description) output += `- **Summary**: ${article.description}\n`;
                    if (article.url) output += `- [Read Full Article](${article.url})\n`;
                    output += `\n`;
                });
            } else {
                output += 'No articles found for this search.\n';
            }

            res.writeHead(200, {'Content-Type': 'application/json'});
            res.end(JSON.stringify({
                choices: [{ message: { content: output, provider: 'GNews' }, finish_reason: 'stop' }]
            }));
        } catch (e) {
            res.writeHead(500, {'Content-Type': 'application/json'});
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }
    
    // ═══════════════════════════════════════════════════════
// DYNAMIC DIAGRAM GENERATION ENDPOINT
// ═══════════════════════════════════════════════════════
if (req.method === 'POST' && req.url === '/api/generate-diagram') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > MAX_BODY_CHARS) rejectBigBody(req, res); });
    req.on('end', async () => {
        try {
            const { topic, label, fullPrompt } = JSON.parse(body);
            const svg = await generateDiagramSVG(topic, label, fullPrompt);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ svg }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
    });
    return;
}

// ═══════════════════════════════════════════════════════
// DIAGRAM TO IMAGE/PDF ENDPOINT
// ═══════════════════════════════════════════════════════
if (req.method === 'POST' && req.url === '/api/diagram-to-image') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > MAX_BODY_CHARS) rejectBigBody(req, res); });
    req.on('end', async () => {
        try {
            const { svg, label, format } = JSON.parse(body);
            const result = await convertDiagramToFile(svg, label, format || 'png');
            if (format === 'pdf') {
                res.writeHead(200, { 'Content-Type': 'application/pdf' });
            } else {
                res.writeHead(200, { 'Content-Type': 'image/png' });
            }
            res.end(result);
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
    });
    return;
}

// ═══════════════════════════════════════════════════════
    // ROADMAP GENERATION ENDPOINT
    // ═══════════════════════════════════════════════════════
    if (req.method === 'POST' && req.url === '/api/generate-roadmap') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > MAX_BODY_CHARS) rejectBigBody(req, res); });
    req.on('end', async () => {
        try {
            const { topic, format = 'svg' } = JSON.parse(body);
            if (!topic) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Missing topic' }));
                return;
            }

            // ── Step A: ask LLM for CONTENT ONLY (no coordinates, no SVG) ──
            const keyObj = keyPool.getKey('sambanova-deepseek')
                        || keyPool.getKey('chatanywhere')
                        || keyPool.getKey('pawan');

            if (!keyObj) {
                res.writeHead(503, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'No AI available' }));
                return;
            }

            const contentPrompt = `You are a technical curriculum designer.
Create a learning roadmap for: "${topic}"

Return ONLY a raw JSON object. No markdown, no backticks, no explanation.

{
  "title": "Full Stack Web Development Roadmap",
  "subtitle": "From beginner to job-ready — estimated 6-12 months",
  "sections": [
    {
      "label": "Foundations",
      "color": "#4f46e5",
      "skills": [
        { "name": "HTML & CSS", "time": "3-4 weeks", "optional": false, "type": "normal" },
        { "name": "JavaScript Basics", "time": "4-6 weeks", "optional": false, "type": "normal" },
        { "name": "Git & GitHub", "time": "1 week", "optional": false, "type": "milestone" },
        { "name": "Command Line", "time": "3 days", "optional": true, "type": "normal" }
      ]
    },
    {
      "label": "Frontend",
      "color": "#0891b2",
      "skills": [
        { "name": "React", "time": "4-6 weeks", "optional": false, "type": "normal" },
        { "name": "TypeScript", "time": "2-3 weeks", "optional": false, "type": "normal" },
        { "name": "CSS Frameworks", "time": "1 week", "optional": true, "type": "normal" }
      ]
    }
  ]
}

Rules:
- 3 to 5 sections (beginner → intermediate → advanced)
- 3 to 9 skills per section
- skill "name" must be SHORT: 2-4 words maximum, never more than 5 words
- skill "time" must be SHORT: e.g. "2 weeks", "3 days", never a full sentence
- "type" must be one of: "normal", "milestone", "warn"
- "optional" must be true or false
- Use distinct hex color for each section
- Return ONLY the JSON object, nothing else`;

            let rawContent = '';
            try {
                const data = await callAPI(keyObj, [{ role: 'user', content: contentPrompt }], 2000);
                keyPool.releaseKey(keyObj);
                rawContent = data.choices?.[0]?.message?.content || '';
            } catch(e) {
                keyPool.releaseKey(keyObj, e);
                throw new Error('AI content generation failed: ' + e.message);
            }

            // ── Step B: parse JSON content ─────────────────────────────
            const stripped = rawContent
                .replace(/```json\s*/gi, '')
                .replace(/```\s*/g, '')
                .trim();

            const jsonMatch = stripped.match(/\{[\s\S]*\}/);
            if (!jsonMatch) throw new Error('LLM did not return valid JSON');

            let roadmapData = null;
            try {
                roadmapData = JSON.parse(jsonMatch[0]);
            } catch(e) {
                // Attempt light repair
                try {
                    roadmapData = JSON.parse(
                        jsonMatch[0]
                            .replace(/,\s*}/g, '}')
                            .replace(/,\s*]/g, ']')
                    );
                } catch(e2) {
                    throw new Error('Could not parse LLM JSON: ' + e2.message);
                }
            }

            // ── Step C: render SVG using our layout engine ─────────────
            const parsed = parseRoadmapSkills(roadmapData);
            if (!parsed) throw new Error('Roadmap data structure invalid');

            const svgOutput = buildRoadmapSVG(parsed);

            if (format === 'pdf') {
                const pdfBuffer = await convertDiagramToFile(svgOutput, topic, 'pdf');
                res.writeHead(200, { 'Content-Type': 'application/pdf' });
                res.end(pdfBuffer);
            } else if (format === 'png') {
                const pngBuffer = await convertDiagramToFile(svgOutput, topic, 'png');
                res.writeHead(200, { 'Content-Type': 'image/png' });
                res.end(pngBuffer);
            } else {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ svg: svgOutput }));
            }

        } catch (e) {
            console.error('[Roadmap] Error:', e.message);
            if (!res.headersSent) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        }
    });
    return;
}

    // ═══════════════════════════════════════════════════════
    // DETAILED ROADMAP PDF — full-length, formatted text
    // ═══════════════════════════════════════════════════════
    if (req.method === 'POST' && req.url === '/api/roadmap-pdf') {
        let body = '';
        req.on('data', c => { body += c; if (body.length > MAX_BODY_CHARS) rejectBigBody(req, res); });
        req.on('end', async () => {
            try {
                const { topic } = JSON.parse(body);
                if (!topic) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Missing topic' }));
                    return;
                }

                const keyObj = keyPool.getKey('sambanova-deepseek')
                            || keyPool.getKey('chatanywhere')
                            || keyPool.getKey('pawan');
                if (!keyObj) {
                    res.writeHead(503, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'No AI available' }));
                    return;
                }

                const prompt = `Create a comprehensive, detailed learning roadmap document for: "${topic}"

Format as clean markdown with NO numbering lists. Use this structure:

# ${topic} — Complete Learning Roadmap

## Overview
2-3 paragraphs describing the journey, prerequisites, and outcomes.

## Phase: [Phase Name]
### [Skill Name]
**What it is:** 1-2 sentences.
**Why it matters:** 1 sentence.
**Key concepts:** concept A, concept B, concept C
**Time estimate:** X weeks
**Resources:** suggest 2-3 resource types

(repeat for each skill in this phase)

(repeat for each phase — at least 4 phases)

## Career Paths
Describe 3-4 roles this roadmap leads to.

## Tips for Success
4-5 actionable paragraphs, no bullet points.

Write at least 1500 words. Be detailed and educational.
Do NOT use numbered lists anywhere. Use bold for terms and keywords.`;

                const data = await callAPI(keyObj,
                    [{ role: 'user', content: prompt }], 4000);
                keyPool.releaseKey(keyObj);

                const content = data.choices?.[0]?.message?.content || '';

                // Send as JSON so the client's existing PDF generator can use it
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ markdown: content, topic }));

            } catch (e) {
                if (!res.headersSent) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: e.message }));
                }
            }
        });
        return;
    }
    
    // ═══════════════════════════════════════════════════════
    // WEB SOURCES SEARCH ENDPOINT
    // ═══════════════════════════════════════════════════════
    if (req.method === 'GET' && req.url.startsWith('/api/search-sources')) {
        const urlParams = new URL(req.url, `http://localhost:${PORT}`).searchParams;
        const query = urlParams.get('q');

        if (!query) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ results: [] }));
            return;
        }

        try {
            let results = [];

            // ── Try SerpAPI first ──
            if (process.env.SERPAPI_KEY) {
                const serpUrl = `https://serpapi.com/search.json?q=${encodeURIComponent(query)}&num=6&api_key=${process.env.SERPAPI_KEY}`;
                const r = await fetch(serpUrl, {
                    headers: { 'User-Agent': 'AI-Assistant/1.0' }
                });
                if (r.ok) {
                    const data = await r.json();
                    results = (data.organic_results || []).slice(0, 6).map(item => {
                        let favicon = '';
                        try {
                            favicon = `https://www.google.com/s2/favicons?sz=64&domain=${new URL(item.link).hostname}`;
                        } catch (_) {}
                        return {
                            title:   item.title   || '',
                            url:     item.link    || '',
                            snippet: item.snippet || '',
                            favicon
                        };
                    });
                }
            }

            // ── Fallback: Google Custom Search ──
            if (results.length === 0 && process.env.GOOGLE_CSE_KEY && process.env.GOOGLE_CSE_CX) {
                const cseUrl = `https://www.googleapis.com/customsearch/v1?q=${encodeURIComponent(query)}&num=6&key=${process.env.GOOGLE_CSE_KEY}&cx=${process.env.GOOGLE_CSE_CX}`;
                const r = await fetch(cseUrl, {
                    headers: { 'User-Agent': 'AI-Assistant/1.0' }
                });
                if (r.ok) {
                    const data = await r.json();
                    results = (data.items || []).slice(0, 6).map(item => {
                        let favicon = '';
                        try {
                            favicon = `https://www.google.com/s2/favicons?sz=64&domain=${new URL(item.link).hostname}`;
                        } catch (_) {}
                        return {
                            title:   item.title   || '',
                            url:     item.link    || '',
                            snippet: item.snippet || '',
                            favicon
                        };
                    });
                }
            }

            res.writeHead(200, {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            });
            res.end(JSON.stringify({ results }));

        } catch (e) {
            console.error('[search-sources]', e.message);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ results: [] }));
        }
        return;
    }
    
    // ═══════════════════════════════════════════════════════
    // DEEP SCRAPE ENDPOINT — scrapes a URL and returns structured data
    // ═══════════════════════════════════════════════════════
    if (req.method === 'POST' && req.url === '/api/scrape') {
        let body = '';
        req.on('data', c => { body += c; if (body.length > MAX_BODY_CHARS) rejectBigBody(req, res); });
        req.on('end', async () => {
            try {
                const { url, mode = 'text' } = JSON.parse(body);
                if (!url || !/^https?:\/\//.test(url)) {
                    res.writeHead(400, {'Content-Type': 'application/json'});
                    res.end(JSON.stringify({ error: 'Invalid URL' }));
                    return;
                }

                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), 15000);

                const r = await fetch(url, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (compatible; AI-Assistant/1.0)',
                        'Accept': 'text/html,application/xhtml+xml,*/*;q=0.9',
                        'Accept-Language': 'en-US,en;q=0.9'
                    },
                    signal: controller.signal
                });
                clearTimeout(timeout);

                const html = await r.text();
                const hostname = new URL(url).hostname;

                // Strip HTML tags, get text
                const text = html
                    .replace(/<script[\s\S]*?<\/script>/gi, '')
                    .replace(/<style[\s\S]*?<\/style>/gi, '')
                    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
                    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
                    .replace(/<[^>]+>/g, ' ')
                    .replace(/\s{2,}/g, ' ')
                    .replace(/&nbsp;/g, ' ')
                    .replace(/&amp;/g, '&')
                    .replace(/&lt;/g, '<')
                    .replace(/&gt;/g, '>')
                    .trim()
                    .slice(0, 8000); // safe limit

                // Extract metadata
                const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
                const descMatch  = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)
                                 || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i);
                const h1Match    = html.match(/<h1[^>]*>([^<]+)<\/h1>/i);

                res.writeHead(200, {'Content-Type': 'application/json'});
                res.end(JSON.stringify({
                    url,
                    hostname,
                    title:       (titleMatch?.[1] || '').trim(),
                    description: (descMatch?.[1]  || '').trim(),
                    h1:          (h1Match?.[1]     || '').trim().replace(/<[^>]+>/g, ''),
                    text,
                    length: text.length
                }));
            } catch (e) {
                res.writeHead(500, {'Content-Type': 'application/json'});
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }
    
    // ═══════════════════════════════════════════════════════
    // SITE ANALYSIS ENDPOINT — identifies tech stack like WhatWeb
    // ═══════════════════════════════════════════════════════
    if (req.method === 'POST' && req.url === '/api/site-analyze') {
        let body = '';
        req.on('data', c => { body += c; if (body.length > MAX_BODY_CHARS) rejectBigBody(req, res); });
        req.on('end', async () => {
            try {
                const { url } = JSON.parse(body);
                if (!url || !/^https?:\/\//.test(url)) {
                    res.writeHead(400, {'Content-Type': 'application/json'});
                    res.end(JSON.stringify({ error: 'Invalid URL' }));
                    return;
                }

                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), 12000);

                const r = await fetch(url, {
                    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AI-Assistant/1.0)' },
                    signal: controller.signal
                });
                clearTimeout(timeout);

                const html = await r.text();
                const headers = Object.fromEntries(r.headers.entries());

                // Fingerprint detection rules
                const fingerprints = {
                    'WordPress':      [/wp-content\//i, /wp-includes\//i, /WordPress/i],
                    'React':          [/react\.min\.js/i, /ReactDOM/i, /__REACT/i],
                    'Vue.js':         [/vue\.min\.js/i, /v-bind:/i, /vue@/i],
                    'Angular':        [/angular\.min\.js/i, /ng-app/i, /ng-controller/i],
                    'Next.js':        [/__NEXT_DATA__/i, /next\/dist/i],
                    'Nuxt':           [/__nuxt__/i, /_nuxt\//i],
                    'Laravel':        [/laravel_session/i, /Laravel/i],
                    'Django':         [/csrfmiddlewaretoken/i, /django/i],
                    'Bootstrap':      [/bootstrap\.min\.css/i, /btn-primary/i],
                    'Tailwind':       [/tailwindcss/i, /tw-/i, /class="[^"]*\bflex\b/i],
                    'jQuery':         [/jquery\.min\.js/i, /jquery-/i],
                    'Cloudflare':     [/cloudflare/i, /__cfduid/i],
                    'Google Analytics':[/google-analytics\.com/i, /gtag\(/i, /UA-\d/i],
                    'Nginx':          [/nginx/i],
                    'Apache':         [/apache/i],
                    'Node.js':        [/express/i, /node\.js/i],
                    'PHP':            [/\.php/i, /PHPSESSID/i],
                    'Ruby on Rails':  [/rails/i, /ruby/i],
                    'Shopify':        [/shopify/i, /myshopify\.com/i],
                    'Wix':            [/wixsite\.com/i, /wix\.com/i],
                    'Stripe':         [/stripe\.com\/v3/i, /Stripe\(/i],
                };

                const detected = {};
                const combined = html + JSON.stringify(headers);
                for (const [tech, patterns] of Object.entries(fingerprints)) {
                    if (patterns.some(p => p.test(combined))) {
                        detected[tech] = true;
                    }
                }

                // Extract headers of interest
                const interestingHeaders = {};
                const headerKeys = ['server', 'x-powered-by', 'x-generator', 'x-cms', 'set-cookie', 'content-security-policy'];
                for (const k of headerKeys) {
                    if (headers[k]) interestingHeaders[k] = headers[k].substring(0, 200);
                }

                // Run WhatWeb if installed
                let whatwebOutput = null;
                try {
                    const { stdout } = await execFileAsync('whatweb', [url, '--no-errors', '--log-brief=-'], {
                        timeout: 10000
                    });
                    whatwebOutput = stdout.trim();
                } catch (_) {
                    // WhatWeb not installed — graceful skip
                }

                res.writeHead(200, {'Content-Type': 'application/json'});
                res.end(JSON.stringify({
                    url,
                    hostname: new URL(url).hostname,
                    status: r.status,
                    technologies: Object.keys(detected),
                    headers: interestingHeaders,
                    whatweb: whatwebOutput,
                    htmlSize: html.length
                }));
            } catch (e) {
                res.writeHead(500, {'Content-Type': 'application/json'});
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }
    
    // ═══════════════════════════════════════════════════════
    // LINUX COMMAND EXECUTOR — safe subset of commands
    // ═══════════════════════════════════════════════════════
    if (req.method === 'POST' && req.url === '/api/run-command') {
        if (!process.env.ALLOW_CODE_EXEC) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'disabled' }));
            return;
        }
        let body = '';
        req.on('data', c => { body += c; if (body.length > MAX_BODY_CHARS) rejectBigBody(req, res); });
        req.on('end', async () => {
            try {
                const { command } = JSON.parse(body);

                // Whitelist of safe command prefixes
                const ALLOWED = [
                    'curl ', 'wget ', 'ping ', 'nmap ', 'dig ', 'host ',
                    'whois ', 'traceroute ', 'netstat ', 'ss ', 'ifconfig',
                    'ip addr', 'ip route', 'whatweb ', 'nikto ',
                    'python3 ', 'python ', 'node ', 'ls ', 'cat ',
                    'wc ', 'head ', 'tail ', 'grep ', 'find ', 'echo ',
                    'date', 'uptime', 'uname', 'df ', 'du ', 'free',
                    'ps aux', 'top -bn1', 'lsof ', 'openssl ',
                    'ffprobe ', 'exiftool ', 'file '
                ];

                const isAllowed = ALLOWED.some(prefix => command.trim().startsWith(prefix));
                if (!isAllowed) {
                    res.writeHead(403, {'Content-Type': 'application/json'});
                    res.end(JSON.stringify({
                        error: 'Command not in allowlist',
                        allowed: ALLOWED
                    }));
                    return;
                }

                // Block dangerous patterns
                const BLOCKED = [/[;&|`$(){}]/, /rm /, /dd /, /mkfs/, /format/, /sudo/, /su /, /chmod/, /chown/];
                if (BLOCKED.some(p => p.test(command))) {
                    res.writeHead(403, {'Content-Type': 'application/json'});
                    res.end(JSON.stringify({ error: 'Blocked pattern detected' }));
                    return;
                }

                const parts = command.trim().split(/\s+/);
                const { stdout, stderr } = await execFileAsync(parts[0], parts.slice(1), {
                    timeout: 15000,
                    maxBuffer: 2 * 1024 * 1024
                });

                res.writeHead(200, {'Content-Type': 'application/json'});
                res.end(JSON.stringify({ command, stdout, stderr, success: true }));
            } catch (e) {
                res.writeHead(200, {'Content-Type': 'application/json'});
                res.end(JSON.stringify({ command: '', stdout: '', stderr: e.message, success: false }));
            }
        });
        return;
    }
    if (req.method === 'POST' && req.url === '/api/run-java-docker') {
        if (!process.env.ALLOW_CODE_EXEC) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'disabled' }));
            return;
        }
        let body = '';
        req.on('data', c => { body += c; if (body.length > MAX_BODY_CHARS) rejectBigBody(req, res); });
        req.on('end', async () => {
            try {
                const { code } = JSON.parse(body);
                
                // Fix class name to Main
                let fixedCode = code;
                const classMatch = fixedCode.match(/public\s+class\s+(\w+)/);
                if (classMatch && classMatch[1] !== 'Main') {
                    fixedCode = fixedCode.replace(
                        new RegExp(`public\\s+class\\s+${classMatch[1]}`, 'g'),
                        'public class Main'
                    );
                }
                
                // ✅ FIXED: Proper template literal syntax
                const tmpId = `java_${Date.now()}_${Math.random().toString(36).slice(2)}`;
                const tmpDir = path.join(os.tmpdir(), tmpId);
                fs.mkdirSync(tmpDir, { recursive: true });
                fs.writeFileSync(path.join(tmpDir, 'Main.java'), fixedCode);
                
                // Use Docker for isolation
                const { stdout, stderr } = await execFileAsync('docker', [
                    'run', '--rm', '-v', `${tmpDir}:/code`, '-w', '/code',
                    'openjdk:17-slim', 'bash', '-c',
                    'javac Main.java && java Main'
                ], { timeout: 30000 });
                
                fs.rmSync(tmpDir, { recursive: true, force: true });
                
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ stdout, stderr, success: true }));
            } catch (e) {
                try { if (typeof tmpDir !== 'undefined' && tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true }); } catch(_) {}
                
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ stdout: '', stderr: e.message, success: false }));
            }
        });
        return;
    }
    
    // ═══════════════════════════════════════════════════════
    // JAVA DEDICATED EXECUTOR - fixes class name issues
    // ═══════════════════════════════════════════════════════
    if (req.method === 'POST' && req.url === '/api/run-java') {
        if (!process.env.ALLOW_CODE_EXEC) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'disabled' }));
            return;
        }
        let body = '';
        req.on('data', c => { body += c; if (body.length > MAX_BODY_CHARS) rejectBigBody(req, res); });
        req.on('end', async () => {
            try {
                const { code } = JSON.parse(body);
                if (!code || code.length > 100000) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Missing or oversized code' }));
                    return;
                }

                // Fix Java code before execution (hljs corruption, package stripping, public type normalisation)
                const fixedCode = fixJavaCode(code);

                const tmpId = `java_${Date.now()}_${Math.random().toString(36).slice(2)}`;
                const tmpDir = path.join(os.tmpdir(), tmpId);
                fs.mkdirSync(tmpDir, { recursive: true });
                
                const javaFile = path.join(tmpDir, 'Main.java');
                fs.writeFileSync(javaFile, fixedCode, 'utf-8');
                
                let stdout = '', stderr = '';
                let success = false;
                
                try {
                    // Compile
                    let { stderr: compileErr } = await execFileAsync('javac', ['-encoding', 'UTF-8', '-d', tmpDir, javaFile], {
                        cwd: tmpDir,
                        timeout: 30000
                    });
                    
                    // ── Auto-fix: raw generic types cause "Object cannot be converted to X" ──
                    if (compileErr && compileErr.match(/incompatible types: Object cannot be converted to/)) {
                        let autoFixed = fixedCode;
                        for (const m of compileErr.matchAll(/incompatible types: Object cannot be converted to (\w+)/g)) {
                            const T = m[1];
                            autoFixed = autoFixed
                                .replace(/\bList<Object>\s+(\w+)/g,      `List<${T}> $1`)
                                .replace(/\bArrayList<Object>\s+(\w+)/g, `ArrayList<${T}> $1`)
                                .replace(/\bOptional<Object>\s+(\w+)/g,  `Optional<${T}> $1`);
                        }
                        if (autoFixed !== fixedCode) {
                            console.log('[Java-Fix] Auto-injecting generic types, retrying compile…');
                            fs.writeFileSync(javaFile, autoFixed, 'utf-8');
                            try {
                                const { stderr: retryErr } = await execFileAsync(
                                    'javac', ['-encoding', 'UTF-8', '-d', tmpDir, javaFile],
                                    { cwd: tmpDir, timeout: 15000 }
                                );
                                if (!retryErr || !retryErr.includes('error:')) {
                                    console.log('[Java-Fix] Retry compile succeeded ✓');
                                    compileErr = retryErr || '';
                                }
                            } catch(retryEx) {
                                console.log('[Java-Fix] Retry failed:', retryEx.message.substring(0, 80));
                            }
                        }
                    }

                    if (compileErr && compileErr.trim()) {
                        // Format compilation error nicely
                        const lines = compileErr.split('\n');
                        const errors = [];
                        for (const line of lines) {
                            const lineMatch = line.match(/Main\.java:(\d+):\s*error:\s*(.+)/);
                            if (lineMatch) {
                                const lineNum = parseInt(lineMatch[1]);
                                const errMsg = lineMatch[2];
                                const codeLines = fixedCode.split('\n');
                                const codeLine = codeLines[lineNum - 1] || '';
                                errors.push(`Line ${lineNum}: ${errMsg}`);
                                if (codeLine.trim()) errors.push(`  → ${codeLine.trim()}`);
                            } else if (line.trim() && !line.includes('^')) {
                                errors.push(line);
                            }
                        }
                        // Detect "cannot find symbol" — class defined in a different code block
                        const missingClasses = [];
                        for (const err of errors) {
                            const m = err.match(/symbol:\s*class\s+(\w+)/);
                            if (m) missingClasses.push(m[1]);
                        }
                        if (missingClasses.length > 0) {
                            const tip = `\n\n💡 Tip: Classes [${missingClasses.join(', ')}] are not defined in this code block.\n` +
                                        `   Copy all class definitions into ONE code block and run that.`;
                            throw new Error((errors.join('\n') || compileErr) + tip);
                        }
                        throw new Error(errors.join('\n') || compileErr);
                    }
                    
                    // Run
                    const { stdout: runOut, stderr: runErr } = await execFileAsync('java', ['-cp', tmpDir, '-Dfile.encoding=UTF-8', 'Main'], {
                        cwd: tmpDir,
                        timeout: 15000,
                        maxBuffer: 5 * 1024 * 1024,
                        encoding: 'utf8',
                    });
                    console.log('[Java] Raw stdout:', JSON.stringify(runOut));
                    console.log('[Java] Raw stderr:', JSON.stringify(runErr));
                    stdout = runOut;
                    stderr = runErr;
                    success = !runErr || runErr.trim() === '';
                    
                } catch (execErr) {
                    const errText = execErr.stderr || execErr.stdout || execErr.message || 'Execution failed';
                    if (errText.includes('Main method not found') || errText.includes('Could not find or load main class')) {
                        stderr = 'No main() method found.\n\n' +
                                 'This code defines a class but has no entry point.\n' +
                                 'Add this inside your class to test it:\n\n' +
                                 '  public static void main(String[] args) {\n' +
                                 '      // create an instance and call its methods\n' +
                                 '  }';
                    } else if (errText.includes('cannot find symbol')) {
                        const missing = [];
                        for (const m of errText.matchAll(/symbol:\s*class\s+(\w+)/g)) {
                            if (!missing.includes(m[1])) missing.push(m[1]);
                        }
                        if (missing.length > 0) {
                            stderr = `Class${missing.length > 1 ? 'es' : ''} not found: ${missing.join(', ')}\n\n` +
                                     `💡 This happens when a class is defined in a separate code block.\n` +
                                     `   Combine all classes into ONE code block like this:\n\n` +
                                     `class ${missing[0]} {\n    // paste the ${missing[0]} class body here\n}\n\n` +
                                     `public class Main {\n    public static void main(String[] args) {\n        // your code\n    }\n}`;
                        } else {
                            stderr = errText;
                        }
                    } else {
                        stderr = errText;
                    }
                    success = false;
                } finally {
                    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch(_) {}
                }
                
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ stdout, stderr, success, fixedCode: fixedCode !== code ? fixedCode : null }));
                
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }
    
    // ═══════════════════════════════════════════════════════
    // UNIVERSAL CODE EXECUTOR — Supports Python, Java, C++, Go, Rust, Ruby, PHP, etc.
    // ═══════════════════════════════════════════════════════
    if (req.method === 'POST' && req.url === '/api/install-package') {
        if (!checkRateLimit(clientIP, 5, 60000)) {
            res.writeHead(429, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Rate limited' }));
            return;
        }
        let body = '';
        req.on('data', c => { body += c; if (body.length > 10000) rejectBigBody(req, res); });
        req.on('end', async () => {
            try {
                const parsed = JSON.parse(body);
                const pkgs = (Array.isArray(parsed.packages) ? parsed.packages : []).map(p => String(p).trim()).filter(Boolean);
                if (pkgs.length === 0 || pkgs.length > 10 || !pkgs.every(p => /^[A-Za-z0-9][A-Za-z0-9._-]{0,60}$/.test(p))) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Invalid package list' }));
                    return;
                }
                const py = fs.existsSync('/root/myenv/bin/python3') ? '/root/myenv/bin/python3' : 'python3';
                console.log(`[Installer] ${py} -m pip install ${pkgs.join(' ')}`);
                const { stdout, stderr } = await execFileAsync(py, ['-m', 'pip', 'install', '--disable-pip-version-check', ...pkgs], {
                    timeout: 600000, maxBuffer: 10 * 1024 * 1024
                });
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, stdout: String(stdout).slice(-2000), stderr: String(stderr).slice(-2000) }));
            } catch (e) {
                const detail = String((e.stderr || '') + (e.stdout || '') || e.message).slice(-3000);
                if (!res.headersSent) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, stderr: detail }));
                }
            }
        });
        return;
    }
    
    if (req.method === 'POST' && req.url === '/api/run-python') {
        if (!process.env.ALLOW_CODE_EXEC) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'disabled' }));
            return;
        }
        let body = '';
        
        req.on('data', c => { body += c; if (body.length > MAX_BODY_CHARS) rejectBigBody(req, res); });
        req.on('end', async () => {
            let language = 'python';
            let tmpDir = null;
            try {
                const parsed = JSON.parse(body);
                language = (parsed.language || 'python').toLowerCase().trim();
                const script = parsed.code;
                
                if (!script || script.length > 100000) {
                    res.writeHead(400, {'Content-Type': 'application/json'});
                    res.end(JSON.stringify({ error: 'Missing or oversized script' }));
                    return;
                }

                // ─── FIX BROKEN F-STRINGS AND MULTILINE STRINGS (Python only) ───
                let fixedScript = sanitizeCodeForExecution(script, language);
                if (language === 'python') {
                    const BLOCKED_PATTERNS = [
                        /\b(?:import|from)\s+(?:subprocess|os|pathlib|shutil|socket|ctypes|pty|multiprocessing|threading)\b/i,
                        /\b(?:os\.(?:system|popen|environ|getenv|listdir|walk|remove|unlink|makedirs)|shutil\.(?:rmtree|copy|move)|subprocess\.(?:run|Popen|call|check_output))\b/i,
                        /\b(?:__import__|eval|exec|compile|open)\s*\(/i
                    ];
                    const blockedPattern = BLOCKED_PATTERNS.find(pattern => pattern.test(fixedScript));
                    if (blockedPattern) {
                        res.writeHead(403, {'Content-Type': 'application/json'});
                        res.end(JSON.stringify({ error: 'Blocked operation in Python code' }));
                        return;
                    }
                }

                // ─── LANGUAGE EXECUTION CONFIGURATION ───
                const execMap = {
                    python:   { cmd: fs.existsSync('/root/myenv/bin/python3') ? '/root/myenv/bin/python3' : 'python3', file: 'script.py', timeout: 20000 },
                    ruby:     { cmd: 'ruby',    file: 'script.rb', timeout: 15000 },
                    php:      { cmd: 'php',     file: 'script.php', timeout: 15000 },
                    perl:     { cmd: 'perl',    file: 'script.pl', timeout: 15000 },
                    lua:      { cmd: 'lua',     file: 'script.lua', timeout: 15000 },
                    r:        { cmd: 'Rscript', file: 'script.R', timeout: 15000 },
                    node:     { cmd: 'node',    file: 'script.js', timeout: 15000 },
                    javascript:{ cmd: 'node',   file: 'script.js', timeout: 15000 },
                    js:       { cmd: 'node',    file: 'script.js', timeout: 15000 },
                    bash:     { cmd: 'bash',    file: 'script.sh', timeout: 15000 },
                    sh:       { cmd: 'bash',    file: 'script.sh', timeout: 15000 },
                    go:       { cmd: 'go',      run: 'go run', file: 'code.go', timeout: 20000 },
                    dart:     { cmd: 'dart',    run: 'dart run', file: 'code.dart', timeout: 15000 },
                    java:     { cmd: 'javac',   run: 'java', file: 'Main.java', main: 'Main', compile: true, timeout: 30000 },
                    cpp:      { cmd: 'g++',     run: './a.out', file: 'code.cpp', compile: true, timeout: 30000 },
                    c:        { cmd: 'gcc',     run: './a.out', file: 'code.c', compile: true, timeout: 30000 },
                    csharp:   { cmd: 'mcs',     run: 'mono', file: 'code.cs', runFile: 'code.exe', compile: true, timeout: 30000 },
                    rust:     { cmd: 'rustc',   run: './code', file: 'code.rs', compile: true, timeout: 30000 },
                    swift:    { cmd: 'swiftc',  run: './code', file: 'code.swift', compile: true, timeout: 30000 },
                    kotlin:   { cmd: 'kotlinc', run: 'kotlin', file: 'code.kt', main: 'MainKt', compile: true, timeout: 30000 },
                    scala:    { cmd: 'scalac',  run: 'scala', file: 'code.scala', main: 'Main', compile: true, timeout: 30000 }
                };

                const normalizedLang = (language || 'python').toLowerCase().replace(/\s+/g, '');
                const config = execMap[normalizedLang];
                if (!config) {
                    res.writeHead(400, {'Content-Type': 'application/json'});
                    res.end(JSON.stringify({ 
                        error: `Language "${language}" not supported. Supported: ${Object.keys(execMap).join(', ')}`
                    }));
                    return;
                }

                const tmpId = `code_${Date.now()}_${Math.random().toString(36).slice(2)}`;
                const _execBase = (process.env.HOME && fs.existsSync(process.env.HOME))
                    ? process.env.HOME
                    : os.tmpdir();
                tmpDir = path.join(_execBase, '.code_runs', tmpId);
                fs.mkdirSync(tmpDir, { recursive: true });

                // Unique filename per run for interpreted langs; compiled langs must keep fixed names
                const _needsFixed = config.compile || ['java','go','dart'].includes(language);
                const _ext        = config.file.split('.').pop();
                const _scriptFile = _needsFixed ? config.file : `run_${Date.now()}.${_ext}`;
                const codeFile    = path.join(tmpDir, _scriptFile);
                
                let finalScript = fixedScript;
                if (language === 'java') {
                    finalScript = fixedScript.replace(/public\s+class\s+\w+/, 'public class Main');
                }
                fs.writeFileSync(codeFile, finalScript, 'utf-8');
                
                console.log(`[Executor] Running ${language} (${finalScript.length} chars)`);
                let missingModule = null;
                let images = [];
                let stdout = '', stderr = '';
                let success = false;

                // ─── EXECUTE BASED ON LANGUAGE TYPE ───
                if (language === 'go') {
                    const { stdout: goOut, stderr: goErr } = await execFileAsync('go', ['run', codeFile], {
                        cwd: tmpDir, timeout: config.timeout
                    });
                    stdout = goOut; stderr = goErr; success = true;
                }
                else if (language === 'dart') {
                    const { stdout: dartOut, stderr: dartErr } = await execFileAsync('dart', ['run', codeFile], {
                        cwd: tmpDir, timeout: config.timeout
                    });
                    stdout = dartOut; stderr = dartErr; success = true;
                }
                else if (config.compile || language === 'java') {
                    // Fix Java code before compilation
                    let fixedCode = fixedScript;

                    if (language === 'java') {
                        fixedCode = fixJavaCode(fixedCode);
                        fs.writeFileSync(codeFile, fixedCode, 'utf-8');
                    }
                    
                    // Compile step
                    let compileArgs = [codeFile];
                    if (language === 'csharp' || language === 'cs') {
                        compileArgs = ['-out:' + path.join(tmpDir, 'code.exe'), codeFile];
                    } else if (language === 'rust') {
                        compileArgs = [codeFile, '-o', path.join(tmpDir, 'code')];
                    } else if (language === 'swift') {
                        compileArgs = [codeFile, '-o', path.join(tmpDir, 'code')];
                    } else if (language === 'kotlin' || language === 'scala') {
                        compileArgs = [codeFile, '-d', tmpDir];
                    } else if (language === 'java') {
                        compileArgs = ['-encoding', 'UTF-8', '-d', tmpDir, codeFile];
                    }
                    
                    let compileResult;
                    try {
                        compileResult = await execFileAsync(config.cmd, compileArgs, {
                            cwd: tmpDir, timeout: config.timeout
                        });
                    } catch (compileErr) {
                        // javac exits with code 1 on error — execFile throws, stderr has the message
                        let compileErrText = compileErr.stderr || compileErr.stdout || compileErr.message || '';

                        // Auto-fix: "Object cannot be converted to X" from raw generic types
                        if (language === 'java' && compileErrText.match(/incompatible types: Object cannot be converted to/)) {
                            let autoFixed = fixedCode;
                            for (const m of compileErrText.matchAll(/incompatible types: Object cannot be converted to (\w+)/g)) {
                                const T = m[1];
                                autoFixed = autoFixed
                                    .replace(/\bList<Object>\s+(\w+)/g,      `List<${T}> $1`)
                                    .replace(/\bArrayList<Object>\s+(\w+)/g, `ArrayList<${T}> $1`)
                                    .replace(/\bOptional<Object>\s+(\w+)/g,  `Optional<${T}> $1`);
                            }
                            if (autoFixed !== fixedCode) {
                                console.log('[Java-Fix] run-python: auto-injecting types, retrying…');
                                fs.writeFileSync(codeFile, autoFixed, 'utf-8');
                                fixedCode = autoFixed;
                                try {
                                    await execFileAsync(config.cmd, compileArgs, { cwd: tmpDir, timeout: config.timeout });
                                    compileErrText = '';  // retry succeeded
                                } catch(retryEx) {
                                    compileErrText = retryEx.stderr || retryEx.message || compileErrText;
                                }
                            }
                        }

                        if (compileErrText) {
                        // Extract just the useful part (javac errors can be very verbose)
                        const usefulError = compileErrText
                            .split('\n')
                            .filter(line => line.includes('error:') || line.includes('warning:') || line.includes('^'))
                            .slice(0, 15)
                            .join('\n');
                            throw new Error(`Compilation failed:\n${usefulError || compileErrText}`);
                        }
                    }
                 
                    
                    // Run step
                    let runCmd, runArgs;
                    if (language === 'java') {
                        runCmd = 'java';
                        runArgs = ['-cp', tmpDir, '-Dfile.encoding=UTF-8', 'Main'];
                        console.log('[Java] Running with args:', runArgs);
                    } else if (language === 'cpp' || language === 'c') {
                        runCmd = config.run; runArgs = [];
                    } else if (language === 'csharp' || language === 'cs') {
                        runCmd = 'mono'; runArgs = [path.join(tmpDir, 'code.exe')];
                    } else if (language === 'rust' || language === 'swift') {
                        runCmd = path.join(tmpDir, 'code'); runArgs = [];
                    } else if (language === 'kotlin') {
                        runCmd = 'kotlin'; runArgs = ['-cp', tmpDir, config.main];
                    } else if (language === 'scala') {
                        runCmd = 'scala'; runArgs = ['-cp', tmpDir, config.main];
                    } else {
                        runCmd = config.run; runArgs = [];
                    }
                    
                    // Use exec instead of execFile for better stdout capture
                    const { exec } = await import('child_process');
                    const { promisify } = await import('util');
                    const execAsync = promisify(exec);

                    const javaCommand = `${runCmd} ${runArgs.join(' ')}`;
                    console.log('[Java] Executing command:', javaCommand);

                    const { stdout: runOut, stderr: runErr } = await execAsync(javaCommand, {
                        cwd: tmpDir,
                        timeout: 20000,
                        maxBuffer: 10 * 1024 * 1024,
                        encoding: 'utf8',
                        env: { ...process.env, JAVA_TOOL_OPTIONS: '-Dfile.encoding=UTF-8' },
                        shell: true
                    });
                    console.log('[Java] stdout length:', runOut?.length || 0);
                    console.log('[Java] stdout content:', runOut);
                    console.log('[Java] stderr content:', runErr);
                    stdout = runOut || '';
                    stderr = runErr || '';
                    success = !stderr || stderr.trim() === '' || stdout.length > 0;
                }
                else {
                    // Interpreted languages
                    const usePlot = language === 'python' && /matplotlib|pyplot|seaborn/.test(finalScript);
                    const runArgs = [codeFile];
                    if (usePlot) {
                        fs.writeFileSync(path.join(tmpDir, '_mpl_runner.py'), MPL_RUNNER, 'utf-8');
                        runArgs.unshift(path.join(tmpDir, '_mpl_runner.py'), tmpDir);
                    }
                    try {
                        const { stdout: runOut, stderr: runErr } = await execFileAsync(config.cmd, runArgs, {
                            cwd: tmpDir, timeout: config.timeout, maxBuffer: 5 * 1024 * 1024,
                            env: { ...process.env, PATH: '/root/myenv/bin:' + (process.env.PATH || ''), MPLBACKEND: 'Agg', PYTHONDONTWRITEBYTECODE: '1', NODE_NO_WARNINGS: '1', PYTHONIOENCODING: 'utf-8' }
                        });
                        stdout = runOut; stderr = runErr; success = true;
                    } catch (runEx) {
                        if (runEx.code === 'ENOENT') throw runEx;
                        const partial = runEx.stdout || '';
                        const failText = (runEx.killed ? `Process killed (timeout ${config.timeout / 1000}s or output too large)\n` : '') + (runEx.stderr || runEx.message || '');
                        stdout = '';
                        stderr = (partial ? partial + '\n' : '') + failText.split(codeFile).join('script.py');
                        success = false;
                        const mm = stderr.match(/ModuleNotFoundError: No module named '([^'.]+)/);
                        if (language === 'python' && mm) missingModule = mm[1];
                    }
                    if (usePlot) {
                        for (const f of fs.readdirSync(tmpDir).filter(n => /^fig_\d+\.png$/.test(n)).sort().slice(0, 12)) {
                            images.push('data:image/png;base64,' + fs.readFileSync(path.join(tmpDir, f)).toString('base64'));
                        }
                    }
                }

                // Clean up
                try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch(_) {}
                
                res.writeHead(200, {'Content-Type': 'application/json'});
                res.end(JSON.stringify({ stdout, stderr, success, language, missingModule, images }));

            } catch (execErr) {
                try { if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true }); } catch(_) {}
                
                let errorMsg = execErr.message;
                if (execErr.message.includes('ENOENT')) {
                    errorMsg = `⚠️ ${language} compiler/interpreter not installed.\n` +
                        (language === 'java' ? '  pkg install openjdk-17' :
                         language === 'cpp' ? '  pkg install clang' :
                         language === 'go' ? '  pkg install golang' :
                         language === 'rust' ? '  curl --proto \'=https\' --tlsv1.2 -sSf https://sh.rustup.rs | sh' :
                         `  Please install ${language} runtime`);
                }
                
                if (!res.headersSent) {
                    res.writeHead(200, {'Content-Type': 'application/json'});
                    res.end(JSON.stringify({ stdout: '', stderr: errorMsg, success: false, language }));
                }
            }
        });
        return;
    }
    
    // ═══════════════════════════════════════════════════════
    // QUICK INVESTIGATE — combines scrape + site-analyze + run tools
    // Returns structured context for AI to analyze in chat
    // Triggered by keyword detection in the client, not by dropdown
    // ═══════════════════════════════════════════════════════
    if (req.method === 'POST' && req.url === '/api/quick-investigate') {
        if (!checkRateLimit(clientIP, 20, 60000)) {
            res.writeHead(429, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Rate limited' }));
            return;
        }
        let body = '';
        req.on('data', c => { body += c; if (body.length > MAX_BODY_CHARS) rejectBigBody(req, res); });
        req.on('end', async () => {
            try {
                const { url, mode = 'auto', userPrompt = '' } = JSON.parse(body);

                if (!url || !/^https?:\/\//i.test(url)) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Invalid URL' }));
                    return;
                }

                const results = {};
                const errors  = {};

                // ── 1. Scrape text content ──────────────────────────
                try {
                    const controller = new AbortController();
                    const t = setTimeout(() => controller.abort(), 12000);
                    const r = await fetch(url, {
                        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AI-Assistant/1.0)' },
                        signal: controller.signal
                    });
                    clearTimeout(t);
                    const html = await r.text();
                    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
                    const descMatch  = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)
                                    || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i);
                    const text = html
                        .replace(/<script[\s\S]*?<\/script>/gi, '')
                        .replace(/<style[\s\S]*?<\/style>/gi, '')
                        .replace(/<nav[\s\S]*?<\/nav>/gi, '')
                        .replace(/<footer[\s\S]*?<\/footer>/gi, '')
                        .replace(/<[^>]+>/g, ' ')
                        .replace(/\s{2,}/g, ' ')
                        .replace(/&nbsp;/g, ' ')
                        .replace(/&amp;/g, '&')
                        .replace(/&lt;/g, '<')
                        .replace(/&gt;/g, '>')
                        .trim()
                        .slice(0, 6000);
                    results.scrape = {
                        title:       (titleMatch?.[1] || '').trim(),
                        description: (descMatch?.[1]  || '').trim(),
                        text,
                        status:      r.status,
                        contentType: r.headers.get('content-type') || ''
                    };
                } catch (e) {
                    errors.scrape = e.message;
                }

                // ── 2. Tech stack fingerprinting ────────────────────
                try {
                    const fingerprints = {
                        'WordPress':      [/wp-content\//i, /wp-includes\//i],
                        'React':          [/react\.min\.js/i, /ReactDOM/i],
                        'Vue.js':         [/vue\.min\.js/i, /v-bind:/i],
                        'Angular':        [/angular\.min\.js/i, /ng-app/i],
                        'Next.js':        [/__NEXT_DATA__/i],
                        'Nuxt':           [/__nuxt__/i],
                        'Laravel':        [/laravel_session/i],
                        'Django':         [/csrfmiddlewaretoken/i],
                        'Bootstrap':      [/bootstrap\.min\.css/i],
                        'Tailwind':       [/tailwindcss/i],
                        'jQuery':         [/jquery\.min\.js/i],
                        'Cloudflare':     [/cloudflare/i],
                        'Google Analytics':[/google-analytics\.com/i, /gtag\(/i],
                        'Nginx':          [/nginx/i],
                        'Apache':         [/apache/i],
                        'PHP':            [/\.php/i, /PHPSESSID/i],
                        'Shopify':        [/shopify/i],
                        'Stripe':         [/stripe\.com\/v3/i]
                    };
                    const combined = (results.scrape?.text || '') + JSON.stringify(results.scrape || {});
                    const detected = Object.entries(fingerprints)
                        .filter(([, pats]) => pats.some(p => p.test(combined)))
                        .map(([name]) => name);
                    results.tech = { detected };
                } catch (e) {
                    errors.tech = e.message;
                }

                // ── 3. Optional: yt-dlp info if YouTube URL ─────────
                const isYouTube = /youtu\.?be/.test(url);
                if (isYouTube) {
                    try {
                        const { stdout } = await execFileAsync('yt-dlp', [
                            '--skip-download', '--dump-json', '--no-warnings', '--no-playlist', url
                        ], { timeout: 15000, maxBuffer: 5 * 1024 * 1024 });
                        const info = JSON.parse(stdout);
                        results.youtube = {
                            title:       info.title,
                            uploader:    info.uploader,
                            duration:    info.duration,
                            view_count:  info.view_count,
                            description: (info.description || '').slice(0, 500),
                            tags:        (info.tags || []).slice(0, 15)
                        };
                    } catch (e) {
                        errors.youtube = e.message;
                    }
                }

                // ── 4. Optional: WhatWeb if installed ───────────────
                try {
                    const { stdout } = await execFileAsync('whatweb', [
                        url, '--no-errors', '--log-brief=-'
                    ], { timeout: 8000 });
                    results.whatweb = stdout.trim();
                } catch (_) {
                    // WhatWeb not installed — skip silently
                }

                // ── Build context block for AI ──────────────────────
                const hostname = (() => { try { return new URL(url).hostname; } catch(_) { return url; } })();

                let contextBlock = `<investigation_results url="${url}" hostname="${hostname}">\n`;

                if (results.scrape) {
                    contextBlock += `<page_info>\n`;
                    contextBlock += `Title: ${results.scrape.title || '(none)'}\n`;
                    contextBlock += `Description: ${results.scrape.description || '(none)'}\n`;
                    contextBlock += `HTTP Status: ${results.scrape.status}\n`;
                    contextBlock += `Content-Type: ${results.scrape.contentType}\n`;
                    contextBlock += `</page_info>\n`;
                    contextBlock += `<page_text>\n${results.scrape.text}\n</page_text>\n`;
                }

                if (results.tech?.detected?.length) {
                    contextBlock += `<technologies_detected>${results.tech.detected.join(', ')}</technologies_detected>\n`;
                }

                if (results.whatweb) {
                    contextBlock += `<whatweb_output>${results.whatweb}</whatweb_output>\n`;
                }

                if (results.youtube) {
                    const yt = results.youtube;
                    contextBlock += `<youtube_info>\n`;
                    contextBlock += `Title: ${yt.title}\nUploader: ${yt.uploader}\n`;
                    contextBlock += `Duration: ${yt.duration}s\nViews: ${yt.view_count}\n`;
                    contextBlock += `Description: ${yt.description}\n`;
                    contextBlock += `Tags: ${yt.tags.join(', ')}\n`;
                    contextBlock += `</youtube_info>\n`;
                }

                if (Object.keys(errors).length) {
                    contextBlock += `<investigation_errors>${JSON.stringify(errors)}</investigation_errors>\n`;
                }

                contextBlock += `</investigation_results>`;

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    contextBlock,
                    summary: {
                        url, hostname,
                        title:        results.scrape?.title || '',
                        technologies: results.tech?.detected || [],
                        hasYouTube:   !!results.youtube,
                        hasWhatweb:   !!results.whatweb
                    }
                }));

            } catch (e) {
                if (!res.headersSent) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: e.message }));
                }
            }
        });
        return;
    }

    // ═══════════════════════════════════════════════════════
        // ─── Manim code auto-fixer ───────────────────────────
    function sanitizeManimCode(src) {
        // 1. Fix align_to(DIRECTION, buff=N) → to_edge(DIRECTION, buff=N)
        src = src.replace(/\.align_to\(\s*(LEFT|RIGHT|UP|DOWN)\s*,\s*buff\s*=\s*([\d.]+)\s*\)/g,
            (_, dir, val) => `.to_edge(${dir}, buff=${val})`);

        // 2. Fix align_to(LEFT) with no buff → to_edge(LEFT)
        src = src.replace(/\.align_to\(\s*(LEFT|RIGHT|UP|DOWN)\s*\)/g,
            (_, dir) => `.to_edge(${dir})`);

        // 3. Inject get_secant_line shim + TangentLine guard after "from manim import *"
        const shim = `
# ── server-injected compatibility shim ──
import numpy as _np
def _secant_line_shim(self, p1, p2, color=WHITE, **kw):
    return Line(p1, p2, color=color, **kw)
if not hasattr(Axes, '_secant_patched'):
    Axes.get_secant_line = _secant_line_shim
    Axes._secant_patched = True
# ── end shim ──
`;
        // Insert the shim right after the last top-level import block
        src = src.replace(
            /(^(?:from manim import \*|import manim|from manim import [^\n]+)\n)/m,
            '$1' + shim
        );

        // 4. Fix self.play(obj.method(...)) → self.play(obj.animate.method(...))
        //    Catches: to_edge, move_to, shift, next_to, scale, rotate, flip, set_color
        src = src.replace(
            /self\.play\(\s*(\w+)\.(to_edge|move_to|shift|next_to|scale|rotate|flip|set_color)\s*\(/g,
            'self.play($1.animate.$2('
        );

        // 5. Fix chained: self.play(Write(obj.next_to(...))) where next_to modifies obj first
        //    (this is fine — next_to returns self, so Write receives the positioned obj)

        // 5b. Add to_corner to Fix 4 (extends the animate rewrite list)
        src = src.replace(
            /self\.play\(\s*(\w+)\.(to_corner|to_edge|move_to|shift|next_to|scale|rotate|flip|set_color|set_opacity)\s*\(/g,
            'self.play($1.animate.$2('
        );

        // 5c. Fix numpy shape mismatch: axes.c2p(...)[:2] + 3D point
        // Replace [:2] slices on c2p results with full 3D
        src = src.replace(/axes\.c2p\(([^)]+)\)\[:2\]/g, 'axes.c2p($1)');
        src = src.replace(/axes\.coords_to_point\(([^)]+)\)\[:2\]/g, 'axes.coords_to_point($1)');
        src = src.replace(/\bMathTex\s*\(/g, 'Text(');
        src = src.replace(/\bTex\s*\(/g, 'Text(');
        // Strip LaTeX syntax from Text strings: \frac{a}{b} → a/b, ^{n} → ^n, _{n} → _n
        src = src.replace(/Text\s*\(\s*["']([^"']*)["']/g, (match, content) => {
            const cleaned = content
                .replace(/\\frac\{([^}]+)\}\{([^}]+)\}/g, '$1/$2')
                .replace(/\\\w+\{([^}]+)\}/g, '$1')
                .replace(/\{([^}]+)\}/g, '$1')
                .replace(/\\/g, '');
            return match.replace(content, cleaned);
        });

        // 5d. Replace Unicode math symbols inside Text() strings
        const _umap = {'∇':'grad ','∂':'d','∑':'sum','∫':'integral','≈':'~=',
                        '≠':'!=','≤':'<=','≥':'>=','∞':'inf','π':'pi',
                        'α':'alpha','β':'beta','γ':'gamma','δ':'delta',
                        'λ':'lambda','μ':'mu','σ':'sigma','θ':'theta'};
        for (const [u, a] of Object.entries(_umap)) {
            src = src.split(u).join(a);
        }

        // 6. Remove plot_surface() blocks — Axes has no plot_surface in 2D manim
        //    Remove the variable assignment and the matching self.play(Create(...)) call
        src = src.replace(
            /[ \t]*\w+\s*=\s*axes\.plot_surface\([^)]*(?:\([^)]*\)[^)]*)*\)[^\n]*\n/g, ''
        );
        src = src.replace(
            /[ \t]*self\.play\(Create\(\s*(surface|surface_\w*)\s*\)\)[^\n]*\n/g, ''
        );

        // 7. Fix list coords arithmetic: current_coords + step where current_coords may be a list
        //    Inject np.array() wrapping after assignment from a plain list if followed by arithmetic
        src = src.replace(
            /(\w+)\s*=\s*\[(\s*[\d\-\.]+\s*,\s*[\d\-\.]+\s*)\]/g,
            '$1 = np.array([$2])'
        );

        return src;
    }
    // MANIM ANIMATION RENDERER
    // ═══════════════════════════════════════════════════════
    if (req.method === 'POST' && req.url.split('?')[0] === '/api/manim/render') {
        let body = '';
        req.on('data', c => { body += c; if (body.length > MAX_BODY_CHARS) rejectBigBody(req, res); });
        req.on('end', async () => {
            try {
                const { code, quality = 'l' } = JSON.parse(body);
                if (!code || code.length > 200000) {
                    res.writeHead(400, {'Content-Type':'application/json'});
                    res.end(JSON.stringify({ error: 'Missing or oversized code' })); return;
                }
                const classMatch = code.match(
                    /class\s+(\w+)\s*\(\s*(?:Scene|MovingCameraScene|ZoomedScene|ThreeDScene|GraphScene|VectorScene)\s*\)/
                );
                if (!classMatch) {
                    res.writeHead(400, {'Content-Type':'application/json'});
                    res.end(JSON.stringify({ error: 'No valid Manim Scene class found. Class must extend Scene.' }));
                    return;
                }
                const className = classMatch[1];
                const qualityFlag = `-q${['l','m','h'].includes(quality) ? quality : 'l'}`;
                const uid    = `manim_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
                const tmpDir = path.join(os.tmpdir(), uid);
                const outDir = path.join(os.tmpdir(), uid + '_out');
                await fs.promises.mkdir(tmpDir, { recursive: true });
                await fs.promises.mkdir(outDir, { recursive: true });
                const pyFile = path.join(tmpDir, 'scene.py');
                fs.writeFileSync(pyFile, sanitizeManimCode(code), 'utf-8');
                const PYTHON = fs.existsSync('/root/myenv/bin/python3')
                    ? '/root/myenv/bin/python3' : 'python3';
                const manimArgs = ['-m','manim', qualityFlag,
                                   '--renderer=cairo',
                                   '--disable_caching',
                                   '--media_dir', outDir,
                                   pyFile, className];
                let manimStderr = '';
                let manimFailed = false;
                try {
                    const r = await execFileAsync(PYTHON, manimArgs, {
                        timeout: 120000,
                        cwd: tmpDir,
                        env: { ...process.env,
                               PYTHONDONTWRITEBYTECODE: '1',
                               MPLBACKEND: 'Agg',
                               DISPLAY: '',
                               PATH: '/root/myenv/bin:/usr/local/bin:/usr/bin:/bin:' + (process.env.PATH||'') }
                    });
                    manimStderr = (r.stderr || '').slice(0, 4000);
                } catch (execErr) {
                    manimFailed = true;
                    manimStderr = (execErr.stderr || execErr.message || '').slice(0, 4000);
                }
                function findOutput(dir) {
                    try {
                        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                            const f = path.join(dir, e.name);
                            if (e.isDirectory()) { const r = findOutput(f); if (r) return r; }
                            else if (/\.(mp4|gif|webm)$/.test(e.name)) return f;
                        }
                    } catch(_) {}
                    return null;
                }
                const videoPath = manimFailed ? null : findOutput(outDir);
                if (!videoPath) {
                    try { fs.rmSync(tmpDir,{recursive:true,force:true}); } catch(_) {}
                    try { fs.rmSync(outDir,{recursive:true,force:true}); } catch(_) {}
                    res.writeHead(500, {'Content-Type':'application/json'});
                    res.end(JSON.stringify({ error: 'Manim produced no output.\n\nLog:\n' + manimStderr }));
                    return;
                }
                const videoData = await fs.promises.readFile(videoPath);
                const ext = path.extname(videoPath).slice(1);
                const b64 = videoData.toString('base64');
                try { fs.rmSync(tmpDir,{recursive:true,force:true}); } catch(_) {}
                try { fs.rmSync(outDir,{recursive:true,force:true}); } catch(_) {}
                res.writeHead(200, {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
                res.write('{"videoB64":"');
                res.write(b64);
                res.end('","mimeType":' + JSON.stringify(`video/${ext}`) + ',"className":' + JSON.stringify(className) + '}');
            } catch(e) {
                res.writeHead(500, {'Content-Type':'application/json'});
                res.end(JSON.stringify({ error: e.message || 'Manim render failed' }));
            }
        });
        return;
    }

    // ─── PDF Export via Python tool ──────────────────────────────
    if (req.method === 'POST' && req.url === '/api/export-pdf') {
        let body = '';
        req.on('data', c => { body += c; if (body.length > MAX_BODY_CHARS) rejectBigBody(req, res); });
        req.on('end', async () => {
            try {
                const { type, content, title, language, author, profile, videoId } = JSON.parse(body);
                if ((!content && !(type === 'captions' && videoId)) || !type) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Missing content or type' }));
                    return;
                }

                const tmpDir  = os.tmpdir();
                const stamp   = Date.now();
                const inFile  = path.join(tmpDir, `pdf_in_${stamp}.txt`);
                const outFile = `pdf_out_${stamp}.pdf`;
                const outPath = path.join(tmpDir, outFile);

                const safeTitle = (title || (type === 'captions' ? 'Captions' : 'Conversation'))
                    .replace(/[^\w\s\u0600-\u06FF]/g, ' ').trim().slice(0, 80);
                const pdfTitle = String(title || '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
                const safeAuthor = String(author || (type === 'summary' ? 'AI Video Summary' : type === 'captions' ? 'Video Captions' : 'AI Assistant')).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 80);

                let _capExtracted = false;
                const _capCached = (type === 'captions' && /^[\w-]{11}$/.test(String(videoId || '')))
                    ? pdfCaptionTextCache.get(videoId)
                    : undefined;
                if (_capCached) {
                    fs.writeFileSync(inFile, _capCached, 'utf8');
                    _capExtracted = true;
                } else if (type === 'captions' && /^[\w-]{11}$/.test(String(videoId || ''))) {
                    try {
                        const _capPython = fs.existsSync('/root/myenv/bin/python3') ? '/root/myenv/bin/python3' : 'python3';
                        await execFileAsync(_capPython, [
                            path.join(__dirname, 'pdf-tool', 'CaptionExtractor1.py'),
                            'https://www.youtube.com/watch?v=' + videoId,
                            '--lang', 'en',
                            '--filename', path.basename(inFile),
                            '--out-dir', tmpDir,
                            '--batch-mode', 'single',
                            '--no-video-headers',
                            '--no-table-of-contents',
                            '--no-smart-separators',
                            '--quiet'
                        ], { timeout: 90000, maxBuffer: 10 * 1024 * 1024, cwd: path.join(__dirname, 'pdf-tool'), env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } });
                        const _capLines = fs.readFileSync(inFile, 'utf8').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
                        const _capParas = [];
                        for (let i = 0; i < _capLines.length; i += 8) _capParas.push(_capLines.slice(i, i + 8).join(' '));
                        if (_capParas.length) {
                            fs.writeFileSync(inFile, _capParas.join('\n\n'), 'utf8');
                            pdfCaptionTextCache.set(videoId, _capParas.join('\n\n'));
                            _capExtracted = true;
                        }
                    } catch (capErr) {
                        console.error('[PDF] CaptionExtractor1.py failed:', String(capErr.stderr || capErr.stdout || capErr.message || '').trim().split('\n').slice(-4).join('\n'));
                    }
                }
                if (!_capExtracted) {
                    if (!content) throw new Error('Caption extraction failed - see server log');
                    fs.writeFileSync(inFile, content, 'utf8');
                }

                const requestedProfile = String(profile || '').trim();
                const profileName = /^[\w-]{1,40}$/.test(requestedProfile)
                    ? requestedProfile
                    : (type === 'captions' ? 'captions' : type === 'summary' ? 'summary' : 'chat');

                let args = [
                    path.join(__dirname, 'pdf-tool', 'convert.py'),
                    '--file',   inFile,
                    '--format', 'text',
                    '--output', outFile,
                    '--directory', tmpDir,
                    '--title=' + (pdfTitle || safeTitle || 'Document'),
                    '--author=' + safeAuthor,
                    '--language', language || 'en',
                    '--profile-file', path.join(__dirname, 'pdf-tool', 'pdf-profiles.json'),
                    '--profile', profileName
                ];
                if (type === 'captions' || type === 'summary') {
                    const _pdfTitleFinal = pdfTitle || safeTitle || 'Document';
                    args = [
                        path.join(__dirname, 'pdf-tool', 'convert.py'),
                        '-f', inFile,
                        '-F', 'text',
                        '-O', outFile,
                        '-D', tmpDir,
                        '--title=' + _pdfTitleFinal,
                        '--author=Badr Aldin',
                        '--language', _capExtracted ? 'en' : (language || 'en'),
                        '--font-size', '20',
                        '--margin-top', '25',
                        '--margin-left', '15',
                        '--margin-right', '15',
                        '--margin-bottom', '20',
                        '--gutter', '0',
                        '--footer-font-size', '28',
                        '--footer-edge-margin', '14',
                        '--footer-bottom-offset', '10',
                        '--footer-reserve', '34',
                        '--hide-print-datetime',
                        '--drop-cap',
                        '--drop-cap-size', '50',
                        '--drop-cap-style', 'bold',
                        '--drop-cap-case', 'upper',
                        '--drop-cap-font', 'EBGaramond-ExtraBold',
                        '--cover-subheading=' + _pdfTitleFinal,
                        '--heading-font', 'EBGaramond-ExtraBold',
                        '--cover-heading-size', '45',
                        '--title-font', 'EBGaramond-Regular',
                        '--cover-heading-font', 'EBGaramond-ExtraBold',
                        '--categorized',
                        '--symbol-mode', 'styled',
                        '--category-design', 'accent',
                        '--page-numbers', 'bottom'
                    ];
                }
                console.log('[PDF] python3 ' + args.join(' '));

                const _pdfPython = fs.existsSync('/root/myenv/bin/python3') ? '/root/myenv/bin/python3' : 'python3';
                try {
                    await execFileAsync(_pdfPython, args, { timeout: 60000, maxBuffer: 10 * 1024 * 1024, cwd: path.join(__dirname, 'pdf-tool'), env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } });
                } catch (pyErr) {
                    const _pyDetail = String(pyErr.stderr || pyErr.stdout || pyErr.message || '').trim().split('\n').slice(-6).join('\n');
                    console.error('[PDF] convert.py failed:', _pyDetail);
                    try { fs.unlinkSync(inFile); } catch (_) {}
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'PDF generation failed: ' + _pyDetail.slice(-300) }));
                    return;
                }

                if (!fs.existsSync(outPath)) {
                    try { fs.unlinkSync(inFile); } catch (_) {}
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'PDF file was not created' }));
                    return;
                }

                const pdfBuf = fs.readFileSync(outPath);
                try { fs.unlinkSync(inFile); } catch (_) {}
                try { fs.unlinkSync(outPath); } catch (_) {}

                const safeName = encodeURIComponent(safeTitle.replace(/\s+/g, '_') || 'export') + '.pdf';
                res.writeHead(200, {
                    'Content-Type': 'application/pdf',
                    'Content-Disposition': `attachment; filename="${safeName}"`,
                    'Content-Length': pdfBuf.length
                });
                res.end(pdfBuf);
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    // ═══════════════════════════════════════════════════════
    // 404 FALLBACK
    // ═══════════════════════════════════════════════════════
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
});


function fixJavaCode(raw) {
    let c = raw;

    // ── Phase A: hljs corruption reversal ───────────────────────────
    // hljs tokenises identifiers that START with a Java keyword into
    // separate <span> elements; browser textContent adds a space between
    // them, so "introduce" becomes "int roduce", "forEach" → "for Each".
    const JAVA_KW = [
        'byte','short','int','long','float','double','char','boolean',
        'void','abstract','class','return','static','public','private',
        'protected','final','new','this','super','extends','implements',
        'interface','enum','for','while','do','if','else','try','catch',
        'throw','throws','switch','case','break','continue','default',
        'instanceof','synchronized','native','volatile','transient','strictfp'
    ];
    // Modifiers that can NEVER be a method return type — used in the
    // negative-lookahead below to prevent "static voidmain" style bugs.
    const MOD_ALT = 'public|private|protected|static|final|abstract|synchronized|native|volatile|transient|strictfp';

    for (const kw of JAVA_KW) {
        // A1. Method / field CALLS:  "obj.int roduce()" → "obj.introduce()"
        //     Also handles chained calls: "list.for Each(...)"
        c = c.replace(
            new RegExp(`\\.${kw}\\s+([a-zA-Z_][a-zA-Z0-9_]*)`, 'g'),
            (_, rest) => `.${kw}${rest}`
        );

        // A2. Method DECLARATIONS with any return type:
        //     "public void int roduce("   → "public void introduce("
        //     "public String int erpret(" → "public String interpret("
        //     "private static boolean do Something(" → fixed
        //
        //     The negative-lookahead (?!MOD_ALT\s) prevents the return-type
        //     capture group from swallowing a modifier word, which would cause
        //     "public static void main(" → "public static voidmain("
        c = c.replace(
            new RegExp(
                `((?:(?:${MOD_ALT})\\s+)+(?!(?:${MOD_ALT})\\s)([\\w<>\\[\\]]+)\\s+)${kw}\\s+([a-zA-Z_][a-zA-Z0-9_]*)\\s*\\(`,
                'g'
            ),
            (_, prefix, _ret, rest) => `${prefix}${kw}${rest}(`
        );

        // A3. Variable assignments / field declarations on a line by themselves:
        //     "String for matted = ..." → "String formatted = ..."
        //     Only fires when the line has exactly [type] [kw] [rest] = ...
        c = c.replace(
            new RegExp(
                `(?<=^[ \\t]*(?:[\\w<>\\[\\]]+)\\s+)${kw}\\s+([a-zA-Z_][a-zA-Z0-9_]*)(?=\\s*[=;,)])`,
                'gm'
            ),
            (_, rest) => `${kw}${rest}`
        );
    }

    // ── Phase B: package declarations ───────────────────────────────
    // "package com.example;" forces javac to create com/example/Main.class
    // but we run plain "java Main" — strip them entirely.
    c = c.replace(/^\s*package\s+[\w.]+\s*;[ \t]*/gm, '');

    // ── Phase C: public type normalisation ──────────────────────────
    // javac allows exactly ONE public type per file, and it must match
    // the filename (Main.java).  Strategy:
    //   1. Demote EVERY public type to package-private.
    //   2. Find the class/record that contains main() → rename it Main.
    //   3. Re-promote exactly that one type to public.
    //   4. If no main() anywhere, promote whichever is already named Main.
    //   5. If nothing qualifies, wrap all code in public class Main { }.

    // 1. Demote all
    c = c.replace(
        /\bpublic\s+(class|record|interface|enum)\s+(\w+)/g,
        (_, kind, name) => `${kind} ${name}`
    );

    // 2. Find main() owner
    const typeMatches = [...c.matchAll(/\b(class|record)\s+(\w+)(?:\s+extends\s+\w+)?(?:\s+implements\s+[\w,\s<>]+)?\s*\{/g)];
    let mainOwner = null;
    for (const m of typeMatches) {
        const snippet = c.slice(m.index, m.index + 4000);
        if (/\bpublic\s+static\s+void\s+main\s*\(\s*String/.test(snippet)) {
            mainOwner = m[2];
            break;
        }
    }

    if (mainOwner && mainOwner !== 'Main') {
        // Rename class declaration
        c = c.replace(new RegExp(`(\\b(?:class|record)\\s+)${mainOwner}\\b`), `$1Main`);
        // Rename constructor calls
        c = c.replace(new RegExp(`\\bnew\\s+${mainOwner}\\s*\\(`, 'g'), 'new Main(');
    }

    // 3. Promote Main
    if (/\b(class|record|interface|enum)\s+Main\b/.test(c)) {
        c = c.replace(/\b(class|record|interface|enum)\s+Main\b/, (_, kind) => `public ${kind} Main`);
    } else if (mainOwner || /\bpublic\s+static\s+void\s+main\b/.test(c)) {
        // 5. No suitable class found — wrap bare code
        c = `public class Main {\n${c}\n}`;
    }

    // Ensure any remaining duplicate publics are demoted (safety pass)
    let pubSeen = false;
    c = c.replace(
        /\bpublic\s+(class|record|interface|enum)\s+(\w+)/g,
        (match, kind, name) => {
            if (name === 'Main' && !pubSeen) { pubSeen = true; return match; }
            if (name === 'Main') return match; // always keep public class Main
            return `${kind} ${name}`;
        }
    );
    
    // ── Phase D: Generic type erasure fixes ─────────────────────────
    // Models often write raw types (List, Optional, Map) without <T>.
    // Fix: inject the most likely type parameter so javac won't reject it.

    // Optional<T> — infer from source variable type
    c = c.replace(
        /\bOptional\s+(\w+)\s*=\s*Optional\.(of|ofNullable|empty)\(/g,
        (match, varName, method) => `Optional<Object> ${varName} = Optional.${method}(`
    );
    c = c.replace(
        /\bOptional<Object>\s+(\w+)\s*=\s*Optional\.(of|ofNullable)\((\w+)\)/g,
        (match, varName, method, src) => {
            if (c.includes(`String ${src}`) || c.includes(`String ${src} =`))
                return `Optional<String> ${varName} = Optional.${method}(${src})`;
            if (c.includes(`Integer ${src}`) || c.includes(`int ${src}`))
                return `Optional<Integer> ${varName} = Optional.${method}(${src})`;
            return match;
        }
    );

    // List / ArrayList raw types
    c = c.replace(
        /\bList\s+(\w+)\s*=\s*Arrays\.asList\(/g,
        'List<Object> $1 = Arrays.asList('
    );
    c = c.replace(
        /\bArrayList\s+(\w+)\s*=\s*new\s+ArrayList\s*\(\)/g,
        'ArrayList<Object> $1 = new ArrayList<>()'
    );

    // Map raw types
    c = c.replace(
        /\bMap\s+(\w+)\s*=\s*new\s+(HashMap|TreeMap|LinkedHashMap)\s*\(\)/g,
        'Map<String, Object> $1 = new $2<>()'
    );

    // Set raw types
    c = c.replace(
        /\bSet\s+(\w+)\s*=\s*new\s+(HashSet|TreeSet|LinkedHashSet)\s*\(\)/g,
        'Set<Object> $1 = new $2<>()'
    );

    return c;
}

// ═══════════════════════════════════════════════════════════════════
// Startup self-test — runs fixJavaCode() against 15 known cases.
// Any failure is logged as [JAVA-FIX FAIL] so it's easy to grep.
// ═══════════════════════════════════════════════════════════════════
function runJavaSelfTests() {
    const PASS = '\x1b[32m✓\x1b[0m';
    const FAIL = '\x1b[31m✗\x1b[0m';
    let failures = 0;

    const tests = [
        // ── hljs corruption: dot-call path ─────────────────────────
        {
            name: 'dot-call: int roduce → introduce',
            input: 'class A { void m() { p.int roduce(); } }',
            check: c => c.includes('p.introduce(') && !c.includes('int roduce')
        },
        {
            name: 'dot-call: for Each → forEach',
            input: 'class A { void m() { list.for Each(System.out::println); } }',
            check: c => c.includes('.forEach(') && !c.includes('for Each')
        },
        {
            name: 'dot-call: do Something → doSomething',
            input: 'class A { void m() { obj.do Something(); } }',
            check: c => c.includes('.doSomething(') && !c.includes('do Something')
        },
        {
            name: 'dot-call: new Person stays intact',
            input: 'class A { void m() { Person p = new Person(); } }',
            check: c => c.includes('new Person()') && !c.includes('newPerson')
        },

        // ── hljs corruption: method declaration path ────────────────
        {
            name: 'decl: public void int roduce( fixed',
            input: 'class A {\n    public void int roduce() {}\n    public static void main(String[] a){}\n}',
            check: c => c.includes('introduce()') && !c.includes('int roduce')
        },
        {
            name: 'decl: public String int erpret( fixed',
            input: 'class A {\n    public String int erpret(int x) { return ""; }\n    public static void main(String[] a){}\n}',
            check: c => c.includes('interpret(') && !c.includes('int erpret')
        },
        {
            name: 'decl: public static void main( NEVER becomes voidmain',
            input: 'public class Main {\n    public static void main(String[] args) {\n        System.out.println(1);\n    }\n}',
            check: c => !c.includes('voidmain') && c.includes('void main(')
        },
        {
            name: 'decl: private boolean do Check( fixed',
            input: 'class A {\n    private boolean do Check() { return true; }\n    public static void main(String[] a){}\n}',
            check: c => c.includes('doCheck()') && !c.includes('do Check')
        },

        // ── package stripping ───────────────────────────────────────
        {
            name: 'package com.example stripped',
            input: 'package com.example;\npublic class Main {\n    public static void main(String[] a){}\n}',
            check: c => !c.includes('package')
        },

        // ── public type normalisation ───────────────────────────────
        {
            name: 'public record Person demoted',
            input: 'public record Person(String name) {}\npublic class Main { public static void main(String[] a){} }',
            check: c => !c.match(/public\s+record\s+Person/) && c.includes('record Person')
        },
        {
            name: 'public interface Drawable demoted',
            input: 'public interface Drawable { void draw(); }\npublic class Main { public static void main(String[] a){} }',
            check: c => !c.match(/public\s+interface\s+Drawable/) && c.includes('interface Drawable')
        },
        {
            name: 'public enum Color demoted',
            input: 'public enum Color { RED, GREEN }\npublic class Main { public static void main(String[] a){} }',
            check: c => !c.match(/public\s+enum\s+Color/) && c.includes('enum Color')
        },
        {
            name: 'non-Main public class renamed to Main',
            input: 'public class Variables {\n    public static void main(String[] args) {\n        int x=1;\n    }\n}',
            check: c => c.includes('public class Main') && !c.includes('class Variables')
        },

        // ── wrap bare code ──────────────────────────────────────────
        {
            name: 'loose main() wrapped in public class Main',
            input: 'public static void main(String[] args) {\n    System.out.println("hi");\n}',
            check: c => c.includes('public class Main {') && c.includes('void main(')
        },

        // ── regression: integers and doubles in expressions untouched
        {
            name: 'int x = 5 not corrupted',
            input: 'public class Main { public static void main(String[] a){ int x = 5; double d = 3.14; } }',
            check: c => c.includes('int x = 5') && c.includes('double d = 3.14')
        },
    ];

    console.log('\n[Java-Fix] Running self-test suite…');
    for (const t of tests) {
        try {
            const out = fixJavaCode(t.input);
            const ok = t.check(out);
            if (ok) {
                console.log(`  ${PASS}  ${t.name}`);
            } else {
                console.log(`  ${FAIL}  ${t.name}`);
                console.log(`       Input:  ${t.input.replace(/\n/g,' ').slice(0,120)}`);
                console.log(`       Output: ${out.replace(/\n/g,' ').slice(0,120)}`);
                failures++;
            }
        } catch (e) {
            console.log(`  ${FAIL}  ${t.name}  THREW: ${e.message}`);
            failures++;
        }
    }
    if (failures === 0) {
        console.log(`[Java-Fix] All ${tests.length} tests passed ✓\n`);
    } else {
        console.log(`[Java-Fix] ${failures}/${tests.length} tests FAILED — check [JAVA-FIX FAIL] above\n`);
    }
}



// ============= START THE SERVER =============
server.listen(PORT, process.env.HOST || '0.0.0.0', () => {
    runJavaSelfTests();
    const loadedKeys = API_KEYS.filter(k => k.key).length;
    const missingKeys = API_KEYS.filter(k => !k.key).length;
    
    console.log('\n' + '='.repeat(60));
    console.log('🚀 AI Assistant Server Running');
    console.log('='.repeat(60));
    console.log(`📡 Server: http://localhost:${PORT}`);
    console.log(`📊 Stats: http://localhost:${PORT}/stats`);
    console.log(`💚 Health: http://localhost:${PORT}/health`);
    console.log(`🔑 Keys loaded: ${loadedKeys}`);
    
    if (missingKeys > 0) {
        console.log(`⚠️  Keys missing from .env: ${missingKeys} — check your .env file!`);
    }
    
    if (GITHUB_AI_KEYS.length === 0) {
        console.log('⚠️  No GitHub AI keys loaded — word translation will fall back to SambaNova');
    }
    
    console.log('\n🔑 Available APIs:');
    API_KEYS.forEach(api => {
        const status = api.key ? '✅' : '❌ MISSING';
        console.log(`   ${status} ${api.name} (${api.provider})`);
    });
    
    console.log('\n⏱️  Request timeout: 120 seconds');
    console.log('='.repeat(60) + '\n');
});


// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down gracefully...');
    server.close(() => {
        console.log('✅ Server closed');
        process.exit(0);
    });
});

process.on('uncaughtException', (err) => {
    console.error('❌ Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason) => {
    console.error('❌ Unhandled Rejection:', reason);
});