#!/usr/bin/env node

import {writeFileSync, appendFileSync} from 'fs';

const LOG_FILE = process.env.LOG_FILE || '/tmp/mcp-code-context.log';

const safeLog = (level: string, ...args: any[]) => {
    if (!LOG_FILE) return;
    try {
        appendFileSync(LOG_FILE, `[${level}] ${new Date().toISOString()} ${args.join(' ')}\n`);
    } catch (e) {
    }
};

const createLogger = (level: string) => (...args: any[]) => safeLog(level, ...args);

console.log = createLogger('LOG');
console.error = createLogger('ERROR');
console.warn = console.info = console.debug = console.log;

try {
    writeFileSync(LOG_FILE, `[INIT] ${new Date().toISOString()} Code Context MCP Server starting\n`);
} catch (e) {
}

import('./index.js').then(() => {
}).catch(error => {
    safeLog('FATAL', error);
    process.exit(1);
});
