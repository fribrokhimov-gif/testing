import { test, expect, APIRequestContext } from '@playwright/test';
import { getTokens, bearer, env } from '../../api/auth';

// Support chat ("Поддержка" panel)
//   GET  chats?skip=&limit=&username=     — chat list, newest activity first
//   GET  chats/{id}/messages?skip=&limit= — messages, newest first
//   POST chats { subject, role: 'merchant' }              — new chat (one per run)
//   POST chats/{id}/messages  form-data: message, files[] — send (one text + one image per run)
// New messages also arrive over the websocket at wss://tback.noor.uz/ws.
const chatsUrl = `${env.deliveryUrl}/chats`;

type Chat = {
  id: number;
  subject: string;
  status: number;
  user: { id?: number; role?: string; first_name?: string; last_name?: string } | null;
  created_at: string;
  updated_at: string;
  last_message: { message: string; sent_at: string; outgoing: boolean; seen: boolean } | null;
};
type ChatPage = {
  data: Chat[] | null;
  count: number;
  count_details: { open_count: number; acquired_count: number; closed_resolved_count: number; closed_not_resolved_count: number };
  page_size: number;
  current_page: number;
  last_page: number;
};
type Message = { id: number; message: string; outgoing: boolean; seen: boolean; created_at: string; files: string[] | null };

// Access tokens live 60s, so each test logs in fresh
let headers: Record<string, string>;
test.beforeEach(async ({ request }) => {
  headers = bearer((await getTokens(request)).access_token);
});

async function listChats(request: APIRequestContext, params: Record<string, string | number> = {}) {
  const res = await request.get(chatsUrl, { headers, params: { skip: 0, limit: 15, ...params } });
  expect(res.status(), await res.text()).toBe(200);
  const body = (await res.json()) as ChatPage;
  return { ...body, data: body.data ?? [] };
}

async function messages(request: APIRequestContext, chatId: number) {
  const res = await request.get(`${chatsUrl}/${chatId}/messages`, { headers, params: { skip: 0, limit: 15 } });
  expect(res.status(), await res.text()).toBe(200);
  return (((await res.json()) as { data: Message[] | null }).data ?? []);
}

test.describe('Chats — list', () => {
  test('list returns chats with pagination fields', async ({ request }) => {
    const p = await listChats(request);
    for (const k of ['count', 'page_size', 'current_page', 'last_page'] as const) {
      expect(typeof p[k], k).toBe('number');
    }
    expect(p.data.length).toBeLessThanOrEqual(15);
    for (const c of p.data) {
      expect(typeof c.id).toBe('number');
      expect(typeof c.subject, String(c.id)).toBe('string');
      expect(typeof c.status, String(c.id)).toBe('number');
    }
  });

  test('status counts add up to the total', async ({ request }) => {
    const { count, count_details: d } = await listChats(request);
    expect(d.open_count + d.acquired_count + d.closed_resolved_count + d.closed_not_resolved_count).toBe(count);
  });

  test('chats are sorted by latest activity', async ({ request }) => {
    const dates = (await listChats(request)).data.map((c) => c.updated_at);
    expect(dates).toEqual([...dates].sort().reverse());
  });

  test('search with no match returns empty list and zero counts', async ({ request }) => {
    const p = await listChats(request, { username: 'zzqx-no-such-user-91', limit: 10 });
    expect(p.data).toHaveLength(0);
    expect(p.count).toBe(0);
    expect(Object.values(p.count_details).every((n) => n === 0)).toBe(true);
  });
});

test.describe('Chats — search ("Поиск по чатам")', () => {
  // Search (?username=) matches people's names, not the chat subject
  async function chatWithAgent(request: APIRequestContext) {
    const chats = (await listChats(request, { limit: 100 })).data;
    const chat = chats.find((c) => c.user?.first_name);
    test.skip(!chat, 'No chat assigned to a support agent');
    return chat!;
  }

  test('search by support agent name finds their chat', async ({ request }) => {
    const chat = await chatWithAgent(request);
    const p = await listChats(request, { username: chat.user!.first_name!, limit: 10 });
    expect(p.data.map((c) => c.id)).toContain(chat.id);
    expect(p.count).toBe(p.data.length);
  });

  test('search ignores letter case', async ({ request }) => {
    const chat = await chatWithAgent(request);
    const name = chat.user!.first_name!;
    const lower = (await listChats(request, { username: name.toLowerCase(), limit: 100 })).data.map((c) => c.id);
    const upper = (await listChats(request, { username: name.toUpperCase(), limit: 100 })).data.map((c) => c.id);
    expect(lower).toContain(chat.id);
    expect(upper).toEqual(lower);
  });

  test('search by part of a name finds the chat', async ({ request }) => {
    const chat = await chatWithAgent(request);
    const part = chat.user!.first_name!.slice(0, 4);
    const p = await listChats(request, { username: part, limit: 100 });
    expect(p.data.map((c) => c.id)).toContain(chat.id);
  });

  test('search result counts match the results', async ({ request }) => {
    const chat = await chatWithAgent(request);
    const p = await listChats(request, { username: chat.user!.first_name!, limit: 100 });
    const d = p.count_details;
    expect(d.open_count + d.acquired_count + d.closed_resolved_count + d.closed_not_resolved_count).toBe(p.count);
  });

  test('limit applies to search results', async ({ request }) => {
    const chat = await chatWithAgent(request);
    const part = chat.user!.first_name!.slice(0, 4);
    const all = await listChats(request, { username: part, limit: 100 });
    test.skip(all.count < 2, 'Need at least 2 matching chats');
    const one = await listChats(request, { username: part, limit: 1 });
    expect(one.data).toHaveLength(1);
    expect(one.count).toBe(all.count);
    expect(one.last_page).toBe(all.count);
  });
});

test.describe('Chats — messages', () => {
  test('messages are returned newest first', async ({ request }) => {
    const chat = (await listChats(request)).data.find((c) => c.last_message);
    test.skip(!chat, 'No chats with messages');

    const list = await messages(request, chat!.id);
    expect(list.length).toBeGreaterThan(0);
    for (const m of list) {
      expect(typeof m.id).toBe('number');
      expect(typeof m.message, String(m.id)).toBe('string');
      expect(typeof m.outgoing, String(m.id)).toBe('boolean');
    }
    const dates = list.map((m) => m.created_at);
    expect(dates).toEqual([...dates].sort().reverse());
  });

  test('chat preview shows the latest message', async ({ request }) => {
    const chat = (await listChats(request)).data.find((c) => c.last_message);
    test.skip(!chat, 'No chats with messages');

    const [latest] = await messages(request, chat!.id);
    expect(latest.message).toBe(chat!.last_message!.message);
    expect(latest.outgoing).toBe(chat!.last_message!.outgoing);
    expect(Date.parse(latest.created_at)).toBe(Date.parse(chat!.last_message!.sent_at));
  });

  test('attached files have a path', async ({ request }) => {
    const chats = (await listChats(request)).data;
    const withFiles: Message[] = [];
    for (const c of chats) withFiles.push(...(await messages(request, c.id)).filter((m) => m.files?.length));
    test.skip(!withFiles.length, 'No messages with files in the latest 15');

    for (const m of withFiles) {
      for (const f of m.files!) expect(f, String(m.id)).toMatch(/^chat_message_files\/.+\.\w+$/);
    }
  });

  test('unknown chat returns 404', async ({ request }) => {
    const res = await request.get(`${chatsUrl}/999999999/messages`, { headers });
    expect(res.status()).toBe(404);
  });
});

// 1x1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

test.describe('Chats — new chat and messages', () => {
  test.describe.configure({ mode: 'serial' });

  // One chat with two messages per run — everything here reaches the support team
  const stamp = new Date().toISOString();
  const subject = `QA-autotest — please ignore ${stamp}`;
  const text = `QA-autotest ${stamp}`;
  let chat: Chat;
  let sentText: Message;
  let sentImage: Message;

  test('create a new chat', async ({ request }) => {
    const res = await request.post(chatsUrl, { headers, data: { subject, role: 'merchant' } });
    expect(res.status(), await res.text()).toBe(200);

    chat = await res.json();
    expect(typeof chat.id).toBe('number');
    expect(chat.subject).toBe(subject);
  });

  test('new chat appears first in the chat list', async ({ request }) => {
    test.skip(!chat, 'Chat was not created');
    const p = await listChats(request);
    expect(p.data[0]).toMatchObject({ id: chat.id, subject });
  });

  test('send a text message', async ({ request }) => {
    test.skip(!chat, 'Chat was not created');
    const res = await request.post(`${chatsUrl}/${chat.id}/messages`, { headers, multipart: { message: text } });
    expect(res.status(), await res.text()).toBe(200);

    sentText = await res.json();
    expect(sentText).toMatchObject({ message: text, outgoing: true, seen: false });
    expect(typeof sentText.id).toBe('number');
    expect(sentText.files ?? []).toHaveLength(0);
  });

  test('send an image', async ({ request }) => {
    test.skip(!chat, 'Chat was not created');
    const res = await request.post(`${chatsUrl}/${chat.id}/messages`, {
      headers,
      // The panel sends "img" as the text when only a file is attached
      multipart: { message: 'img', files: { name: 'qa-autotest.png', mimeType: 'image/png', buffer: PNG } },
    });
    expect(res.status(), await res.text()).toBe(200);

    sentImage = await res.json();
    expect(sentImage).toMatchObject({ message: 'img', outgoing: true });
    expect(sentImage.files).toHaveLength(1);
    expect(sentImage.files![0]).toMatch(/^chat_message_files\/.+\.png$/);
  });

  test('uploaded image can be downloaded', async ({ request }) => {
    test.skip(!sentImage?.files?.length, 'Image was not sent');
    const res = await request.get(`${env.filesUrl}/${sentImage.files![0]}`);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('image/png');
    expect((await res.body()).equals(PNG)).toBe(true);
  });

  test('chat shows both messages, newest first', async ({ request }) => {
    test.skip(!sentText || !sentImage, 'Messages were not sent');
    const list = await messages(request, chat.id);
    expect(list.map((m) => m.id)).toEqual([sentImage.id, sentText.id]);
  });

  test('chat preview shows the latest message', async ({ request }) => {
    test.skip(!sentImage, 'Image was not sent');
    const c = (await listChats(request)).data.find((x) => x.id === chat.id);
    expect(c?.last_message).toMatchObject({ message: 'img', outgoing: true });
  });
});

test.describe('Chats — send errors', () => {
  test('send to unknown chat is rejected', async ({ request }) => {
    const res = await request.post(`${chatsUrl}/999999999/messages`, { headers, multipart: { message: 'QA-autotest' } });
    expect(res.status()).toBe(404);
  });

  test('create chat and send without token are rejected', async ({ request }) => {
    expect((await request.post(chatsUrl, { data: { subject: 'QA-autotest', role: 'merchant' } })).status()).toBe(401);

    const chat = (await listChats(request)).data[0];
    test.skip(!chat, 'No chats');
    const res = await request.post(`${chatsUrl}/${chat.id}/messages`, { multipart: { message: 'QA-autotest' } });
    expect(res.status()).toBe(401);
  });
});

test.describe('Chats — access', () => {
  test('list and messages without token are rejected', async ({ request }) => {
    expect((await request.get(chatsUrl)).status()).toBe(401);

    const chat = (await listChats(request)).data[0];
    test.skip(!chat, 'No chats');
    expect((await request.get(`${chatsUrl}/${chat.id}/messages`)).status()).toBe(401);
  });
});
