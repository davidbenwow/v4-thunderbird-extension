// A small in-memory Thunderbird for the triage tests: accounts, folders, paged
// message queries, getFull / listAttachments, storage.local. Synthetic data
// only. Mirrors the real API where it matters to the scanner:
//  - message ids are session-scoped: restart() renumbers every message;
//  - query() pages, and continueList() serves the rest;
//  - getFull can fail (offline, encrypted) per message;
//  - MessageHeader carries no In-Reply-To / References — only getFull does.

var FakeMailbox = (function () {
  'use strict';

  function create(spec) {
    const pageSize = spec.pageSize || 3;
    const calls = { query: 0, continueList: 0, getFull: 0, listAttachments: 0, foldersQuery: 0, move: 0, archive: 0 };
    const state = { offline: false, failQueryFolders: new Set(spec.failQueryFolders || []) };
    let nextId = 1;
    let byId = new Map();
    const lists = new Map();
    let nextList = 1;

    function renumber() {
      byId = new Map();
      for (const a of spec.accounts) for (const f of a.folders) for (const m of f.messages) {
        m._id = nextId++;
        byId.set(m._id, { m, f, a });
      }
    }
    renumber();

    function folderOf(f, a) {
      return { id: f.id, accountId: a.id, path: f.path, name: f.name || f.path, specialUse: f.specialUse || [], isVirtual: !!f.isVirtual };
    }

    function header(m, f, a) {
      return {
        id: m._id, headerMessageId: m.hmid, date: new Date(m.date), author: m.author,
        recipients: m.recipients || [], ccList: m.ccList || [], subject: m.subject || '',
        size: m.size || 2000, read: !!m.read, flagged: !!m.flagged, folder: folderOf(f, a)
      };
    }

    function page(listId) {
      const rest = lists.get(listId);
      const chunk = rest.splice(0, pageSize);
      if (!rest.length) lists.delete(listId);
      return { id: rest.length ? listId : null, messages: chunk };
    }

    const api = {
      accounts: {
        async list() { return spec.accounts.map((a) => ({ id: a.id, name: a.name || a.id, type: a.type || 'imap', identities: a.identities || [] })); }
      },
      folders: {
        async query(q) {
          calls.foldersQuery++;
          const out = [];
          for (const a of spec.accounts) {
            if (q.accountId && q.accountId !== a.id) continue;
            for (const f of a.folders) {
              if (q.specialUse && !(f.specialUse || []).some((s) => q.specialUse.indexOf(s) !== -1)) continue;
              out.push(folderOf(f, a));
            }
          }
          return out;
        },
        async get(id) {
          for (const a of spec.accounts) for (const f of a.folders) if (f.id === id) return folderOf(f, a);
          throw new Error('folder not found');
        }
      },
      messages: {
        async query(q) {
          calls.query++;
          if (state.failQueryFolders.has(q.folderId)) throw new Error('query failed');
          const out = [];
          const wantAccounts = q.accountId === undefined ? null : [].concat(q.accountId);
          for (const a of spec.accounts) for (const f of a.folders) {
            if (wantAccounts && wantAccounts.indexOf(a.id) === -1) continue;
            if (q.folderId && f.id !== q.folderId) continue;
            if (q.headerMessageId) {
              for (const m of f.messages) if (m.hmid === q.headerMessageId) out.push(header(m, f, a));
              continue;
            }
            if (!q.folderId) continue;
            for (const m of f.messages) if (!q.fromDate || m.date >= q.fromDate.getTime()) out.push(header(m, f, a));
          }
          const id = 'list' + nextList++;
          lists.set(id, out);
          return page(id);
        },
        async continueList(id) { calls.continueList++; return page(id); },
        async getFull(id) {
          calls.getFull++;
          const hit = byId.get(id);
          if (!hit) throw new Error('stale message id');
          if (state.offline || hit.m.failFull) throw new Error('body unavailable');
          const headers = {};
          if (hit.m.irt) headers['in-reply-to'] = ['<' + hit.m.irt + '>'];
          if (hit.m.refs) headers.references = [hit.m.refs.map((r) => '<' + r + '>').join(' ')];
          for (const k of Object.keys(hit.m.headers || {})) headers[k.toLowerCase()] = [].concat(hit.m.headers[k]);
          return { headers, parts: [{ contentType: 'text/plain', body: hit.m.body || '' }] };
        },
        // Real moves, so a test can check where a message ended up and that
        // putting it back works. `archiveTo` names the folder this mailbox's
        // archiver uses; without it, archive() throws like a folder that
        // cannot be archived to.
        async move(messageIds, destination) {
          calls.move++;
          const destId = destination && destination.id ? destination.id : destination;
          let target = null;
          for (const a of spec.accounts) for (const f of a.folders) if (f.id === destId) target = f;
          if (!target) throw new Error('no such folder: ' + destId);
          for (const id of messageIds) {
            const hit = byId.get(id);
            if (!hit) throw new Error('stale message id');
            hit.f.messages.splice(hit.f.messages.indexOf(hit.m), 1);
            target.messages.push(hit.m);
          }
          renumber();
        },
        async archive(messageIds) {
          calls.archive++;
          if (!spec.archiveTo) throw new Error('no archive folder configured');
          return api.messages.move(messageIds, spec.archiveTo);
        },
        async listAttachments(id) {
          calls.listAttachments++;
          const hit = byId.get(id);
          if (!hit) throw new Error('stale message id');
          return (hit.m.attachments || []).map((name) => ({ name }));
        }
      }
    };

    function storage() {
      const data = {};
      return {
        data,
        async get(keys) {
          if (keys === null || keys === undefined) return Object.assign({}, data);
          const list = Array.isArray(keys) ? keys : typeof keys === 'string' ? [keys] : Object.keys(keys);
          const out = {};
          for (const k of list) if (k in data) out[k] = JSON.parse(JSON.stringify(data[k]));
          return out;
        },
        async set(obj) { for (const k of Object.keys(obj)) data[k] = JSON.parse(JSON.stringify(obj[k])); },
        async remove(keys) { for (const k of Array.isArray(keys) ? keys : [keys]) delete data[k]; }
      };
    }

    return {
      api, calls, state, storage,
      restart() { renumber(); lists.clear(); },
      bodyText(full) { return (full.parts || []).map((p) => p.body || '').join('\n'); }
    };
  }

  return { create };
})();
