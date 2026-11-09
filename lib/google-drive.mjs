import { parse } from 'parse5';
import { UserError } from './common.mjs';

export function googleFileId(url) {
  if (url.hostname === 'drive.google.com') {
    return url.pathname.match(/^\/file\/d\/([\w-]+)(?:\/(?:view|preview|edit))?\/?$/)?.[1]
      || (['/open', '/uc'].includes(url.pathname) ? url.searchParams.get('id') : null);
  }
  if (url.hostname === 'drive.usercontent.google.com' && url.pathname === '/download') return url.searchParams.get('id');
  return null;
}

// Google returns a GET form for large public files that it cannot scan.
// Parse HTML as data; never execute scripts or submit arbitrary page forms.
export function googleConfirmation(html, pageUrl) {
  const expectedId = googleFileId(new URL(pageUrl));
  if (!expectedId || !/^[\w-]+$/.test(expectedId)) return null;
  const nodes = [];
  const visit = node => { nodes.push(node); for (const child of node.childNodes || []) visit(child); };
  visit(parse(html));
  const attrs = node => Object.fromEntries((node.attrs || []).map(a => [a.name, a.value]));
  const form = nodes.find(n => n.tagName === 'form' && attrs(n).id === 'download-form');
  if (!form) return null;
  const attributes = attrs(form);
  if (attributes.method && attributes.method.toLowerCase() !== 'get') return null;
  const target = new URL(attributes.action || pageUrl, pageUrl);
  const allowed = target.protocol === 'https:' && !target.username && !target.password && !target.port
    && ((['drive.google.com', 'docs.google.com'].includes(target.hostname) && target.pathname === '/uc')
      || (target.hostname === 'drive.usercontent.google.com' && target.pathname === '/download'));
  if (!allowed) throw new UserError('Google Drive вернул неподдерживаемый адрес подтверждения скачивания.');
  const allowedParams = new Set(['id', 'export', 'confirm', 'uuid', 'resourcekey']);
  for (const key of target.searchParams.keys()) if (!allowedParams.has(key)) return null;
  const fields = [];
  const collect = node => {
    if (node.tagName === 'input') fields.push(attrs(node));
    for (const child of node.childNodes || []) collect(child);
  };
  collect(form);
  const seen = new Set();
  for (const field of fields) {
    if (field.type?.toLowerCase() !== 'hidden' || !field.name || !allowedParams.has(field.name)) continue;
    if (seen.has(field.name)) return null;
    seen.add(field.name); target.searchParams.set(field.name, field.value || '');
  }
  if (target.searchParams.get('id') !== expectedId || target.searchParams.get('export') !== 'download' || !target.searchParams.get('confirm')) return null;
  const resourcekey = new URL(pageUrl).searchParams.get('resourcekey');
  if (resourcekey && !target.searchParams.has('resourcekey')) target.searchParams.set('resourcekey', resourcekey);
  target.hash = '';
  return target.href;
}
