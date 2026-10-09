import hljs from 'highlight.js/lib/core';
import js from 'highlight.js/lib/languages/javascript';
import ts from 'highlight.js/lib/languages/typescript';
import json from 'highlight.js/lib/languages/json';
import py from 'highlight.js/lib/languages/python';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import xml from 'highlight.js/lib/languages/xml';
import rust from 'highlight.js/lib/languages/rust';
import go from 'highlight.js/lib/languages/go';
import java from 'highlight.js/lib/languages/java';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import cs from 'highlight.js/lib/languages/csharp';
import sql from 'highlight.js/lib/languages/sql';
import yaml from 'highlight.js/lib/languages/yaml';
import md from 'highlight.js/lib/languages/markdown';
import diff from 'highlight.js/lib/languages/diff';
import php from 'highlight.js/lib/languages/php';
import ruby from 'highlight.js/lib/languages/ruby';
import kotlin from 'highlight.js/lib/languages/kotlin';
import swift from 'highlight.js/lib/languages/swift';

const langs: Record<string, any> = { javascript: js, typescript: ts, json, python: py, bash, css, xml, rust, go, java, c, cpp, csharp: cs, sql, yaml, markdown: md, diff, php, ruby, kotlin, swift };
for (const [n, l] of Object.entries(langs)) hljs.registerLanguage(n, l);
const alias: Record<string, string> = { js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', py: 'python', sh: 'bash', shell: 'bash', zsh: 'bash', html: 'xml', svg: 'xml', rs: 'rust', cs: 'csharp', yml: 'yaml', md: 'markdown', rb: 'ruby', kt: 'kotlin', 'c++': 'cpp', golang: 'go', jsonc: 'json' };

/** Returns highlighted HTML (already escaped by hljs) or null when language is unknown. */
export function highlight(code: string, lang: string): string | null {
  const l = alias[lang] ?? lang;
  if (!l || !hljs.getLanguage(l)) return null;
  try { return hljs.highlight(code, { language: l, ignoreIllegals: true }).value; } catch { return null; }
}
