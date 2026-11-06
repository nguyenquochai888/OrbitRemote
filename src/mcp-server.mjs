#!/usr/bin/env node
// Vỏ MCP qua stdio cho phiên do Orbit Remote mở: cho phiên nhắn tin với phiên khác,
// kể cả phiên ở máy khác, và làm việc trong nhóm phiên (groups.mjs).
//
// Cố ý chỉ BA công cụ. Danh sách tên công cụ của mọi máy chủ MCP bị nạp vào ngữ cảnh
// ở mọi lượt, nên mỗi cái tên thêm vào là tiền trả mãi mãi:
// mọi việc của nhóm gom vào một công cụ, chọn bằng "action".
//
// Phiên nhận KHÔNG phải gọi lệnh chờ tin. Đầu máy giữ
// stdin của phiên nhận nên bơm tin vào thẳng thành một lượt mới, kể cả lúc phiên đó
// đang nằm yên.
//
// stdout CHỈ chứa thông điệp giao thức; mọi thứ khác ra stderr.

import net from 'node:net';
import { createInterface } from 'node:readline';
import { lineSplitter, toLine } from './lines.mjs';

const PROTOCOL_VERSION = '2024-11-05';
// Bản của bộ action trong orbit_remote_group; tăng khi thêm action hay tham số. Vỏ nạp một lần lúc phiên mở, nên
// phiên mở từ bản cũ (hay ở máy chưa cập nhật Orbit Remote) không thấy action mới: trạm thấy số cũ thì báo
// (SHELL_VERSION trong groups.mjs phải bằng số này).
const SHELL_VERSION = 2;
const SESSION_ID = process.env.ORBIT_REMOTE_SESSION || '';
const PIPE = process.env.ORBIT_REMOTE_PIPE || '';

let socket = null;
let counter = 0;
const waiting = new Map();

function connect() {
  if (socket && !socket.destroyed) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (!PIPE || !SESSION_ID) {
      reject(new Error('Phiên này không được mở từ Orbit Remote nên không có đường nhắn tin.'));
      return;
    }
    const s = net.connect(PIPE);
    s.setEncoding('utf8');
    s.once('error', (err) => reject(new Error(`Không nối được tới đầu máy Orbit Remote: ${err.message}`)));
    s.once('connect', () => {
      socket = s;
      s.on('data', lineSplitter((m) => {
        const w = waiting.get(m.rid);
        if (!w) return;
        waiting.delete(m.rid);
        if (m.ok) w.resolve(m.data);
        else w.reject(new Error(m.error || 'Đầu máy báo hỏng.'));
      }));
      s.on('close', () => {
        socket = null;
        for (const w of waiting.values()) w.reject(new Error('Mất kết nối tới đầu máy.'));
        waiting.clear();
      });
      ask({ op: 'hello', sessionId: SESSION_ID }).then(resolve, reject);
    });
  });
}

function ask(message) {
  counter += 1;
  const rid = `m${counter}`;
  return new Promise((resolve, reject) => {
    waiting.set(rid, { resolve, reject });
    socket.write(toLine({ ...message, rid }));
  });
}

const TOOLS = [
  {
    name: 'orbit_remote_sessions',
    description:
      'Liệt kê các phiên Claude đang được Orbit Remote quản lý trên mọi máy: mã, tên, máy, ' +
      'trạng thái, thư mục làm việc. Dùng để biết gửi tin cho ai bằng orbit_remote_send.',
    inputSchema: { type: 'object', properties: {} },
    run: async () => {
      await connect();
      return ask({ op: 'list' });
    },
  },
  {
    name: 'orbit_remote_send',
    description:
      'Gửi tin nhắn tới một phiên Claude khác do Orbit Remote quản lý, kể cả phiên ở máy khác. ' +
      'Tin được đưa thẳng vào phiên nhận thành một lượt mới, phiên nhận không phải chờ. ' +
      '"to" là mã phiên, tên phiên, hoặc "tên@máy"; "*" gửi cho mọi phiên đang chạy, ' +
      '"#group" gửi cho mọi phiên cùng nhóm.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Mã phiên, tên phiên, "tên@máy", "*", hoặc "#group"' },
        text: { type: 'string', description: 'Nội dung tin nhắn' },
        needs_action: { type: 'boolean', description: 'true nếu người nhận cần làm gì hay trả lời (nhờ việc, hỏi, xin dụng cụ); false nếu tin chỉ để báo (cảm ơn, đã xong, FYI, đã nhận). Tin false không mở lượt mới cho người nhận: trạm giữ lại và gộp vào lượt kế tiếp của họ, đỡ tốn token.' },
      },
      required: ['to', 'text', 'needs_action'],
    },
    run: async (args) => {
      await connect();
      return ask({ op: 'send', to: String(args.to || ''), text: String(args.text || ''), ...(typeof args.needs_action === 'boolean' ? { needs_action: args.needs_action } : {}) });
    },
  },
  {
    name: 'orbit_remote_group',
    description:
      'Làm việc trong nhóm phiên do chủ dự án lập trên Orbit Remote. "view": mục tiêu, thành viên (vai trò ' +
      'là token trong bảng token như $code, $qa; việc đang làm và hàng chờ), bảng việc, chi phí. Trưởng nhóm: "add_task" ' +
      'giao việc (phiên được giao tự mở lại và nhận tin; đang bận thì việc vào hàng chờ của họ; model, effort ' +
      'chọn theo độ khó), "update_task" nghiệm thu ("done") hay trả lại ("doing" kèm note), "finish" báo đạt mục ' +
      'tiêu. Thành viên: "update_task" việc của mình với "review" (note bàn giao) hay "blocked". Dụng cụ chỉ một ' +
      'phiên dùng được một lúc: "tools" xem bảng tin, "claim_tool" đăng ký (bận thì tự xếp hàng chờ), "release_tool" trả. ' +
      'Ngữ cảnh của chính mình đã lớn: "compact" nén (focus, then), "reset" xoá sạch rồi nhận lại note cùng mục tiêu và việc dở.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['view', 'add_task', 'update_task', 'finish', 'tools', 'claim_tool', 'release_tool', 'compact', 'reset'] },
        task: { type: 'string', description: 'Mã việc, ví dụ "T3" (update_task)' },
        title: { type: 'string', description: 'Tên việc (add_task)' },
        detail: { type: 'string', description: 'Mô tả việc: phạm vi, file liên quan, kết quả cần có' },
        assignee: { type: 'string', description: 'Mã, tên hay token vai trò của thành viên được giao' },
        status: { type: 'string', enum: ['todo', 'queued', 'doing', 'review', 'blocked', 'done'] },
        note: { type: 'string', description: 'Bàn giao: kết quả, file đã đụng, cách đã kiểm; hay lý do bị chặn, điều còn thiếu. Với reset: điều phải nhớ sau khi xoá ngữ cảnh' },
        model: { type: 'string', enum: ['', 'haiku', 'sonnet', 'opus'], description: 'Model cho việc này (add_task, update_task); trạm dùng bản mới nhất của dòng đó' },
        effort: { type: 'string', enum: ['', 'low', 'medium', 'high', 'xhigh', 'max'] },
        tool: { type: 'string', description: 'Tên dụng cụ kèm dự án, ví dụ "Unity Editor (MyGame)" (claim_tool, release_tool)' },
        minutes: { type: 'number', description: 'Thời gian dự kiến dùng dụng cụ, phút (claim_tool)' },
        summary: { type: 'string', description: 'Báo cáo kết quả cho chủ dự án (finish)' },
        focus: { type: 'string', description: 'Điều cần giữ lại khi nén ngữ cảnh (compact)' },
        then: { type: 'string', description: 'Việc làm tiếp ngay sau khi nén (compact)' },
      },
      required: ['action'],
    },
    run: async (args) => {
      await connect();
      // shell: bản của vỏ này, để trạm biết phiên đang dùng công cụ cũ (máy chưa cập nhật Orbit Remote) mà báo.
      return ask({ op: 'group', args: { ...args, shell: SHELL_VERSION } });
    },
  },
];

// ---- Làm việc trên máy khác (remote-ops.mjs) ----------------------------------------------------------------
// Phiên vẫn chạy và tính vào tài khoản Claude của máy này; thao tác chạy trên máy đích. Máy đích phải cho phép máy
// này trong app (hub.mjs machineControl). Kết quả là chữ dễ đọc (và ảnh với màn hình, tệp ảnh), không phải JSON.
const MACHINE = { type: 'string', description: 'Tên máy đích (như trong orbit_machines), ví dụ "May-Van-Phong"' };
const machineTool = (name, action, description, properties, required = []) => ({
  name,
  description,
  rich: true,
  inputSchema: { type: 'object', properties: { machine: MACHINE, ...properties }, required: ['machine', ...required] },
  run: async (args) => {
    await connect();
    return ask({ op: 'machine', action, args });
  },
});
TOOLS.push(
  {
    name: 'orbit_machines',
    description: 'Liệt kê các máy trong Orbit Remote: đang bật hay tắt, hệ điều hành, và phiên này có được làm việc trên máy đó không '
      + '(bằng các công cụ orbit_machine_*). Dùng khi cần làm việc trên máy khác máy đang chạy phiên: phiên vẫn tính vào tài khoản '
      + 'Claude của máy này, còn lệnh, tệp, màn hình, Unity là của máy đích.',
    rich: true,
    inputSchema: { type: 'object', properties: {} },
    run: async () => {
      await connect();
      return ask({ op: 'machine', action: 'machines', args: {} });
    },
  },
  machineTool('orbit_machine_run', 'run',
    'Chạy một lệnh trên máy khác: PowerShell trên Windows (bash trên máy khác). Trả mã thoát, stdout, stderr. Lệnh không '
    + 'tương tác (không chờ gõ phím). Dài nhất timeout_sec giây (mặc định 120, tối đa 600).',
    {
      command: { type: 'string', description: 'Lệnh PowerShell (hay bash), có thể nhiều dòng' },
      cwd: { type: 'string', description: 'Thư mục chạy, đường dẫn tuyệt đối trên máy đích (mặc định: thư mục người dùng)' },
      timeout_sec: { type: 'number', description: 'Giây tối đa (1–600, mặc định 120)' },
    }, ['command']),
  machineTool('orbit_machine_read', 'read',
    'Đọc một tệp trên máy khác, đánh số dòng như công cụ Read. Tệp ảnh (png, jpg, gif, webp) trả về thành ảnh; đường dẫn '
    + 'là thư mục thì liệt kê. Tệp dài thì đọc từng phần bằng offset, limit.',
    {
      path: { type: 'string', description: 'Đường dẫn tuyệt đối trên máy đích' },
      offset: { type: 'number', description: 'Dòng bắt đầu (từ 1)' },
      limit: { type: 'number', description: 'Số dòng (mặc định 2000, tối đa 5000)' },
    }, ['path']),
  machineTool('orbit_machine_write', 'write',
    'Ghi (tạo hay ghi đè) một tệp chữ trên máy khác, tự tạo thư mục cha. Sửa một phần tệp có sẵn thì dùng orbit_machine_edit.',
    {
      path: { type: 'string', description: 'Đường dẫn tuyệt đối trên máy đích' },
      content: { type: 'string', description: 'Toàn bộ nội dung tệp (UTF-8)' },
    }, ['path', 'content']),
  machineTool('orbit_machine_edit', 'edit',
    'Sửa tệp trên máy khác như công cụ Edit: thay đúng old_string bằng new_string. old_string phải khớp đúng một chỗ (hay đặt '
    + 'replace_all). Tệp xuống dòng kiểu Windows vẫn khớp khi viết \\n, và giữ nguyên kiểu xuống dòng. Đọc tệp trước để chép đúng đoạn.',
    {
      path: { type: 'string', description: 'Đường dẫn tuyệt đối trên máy đích' },
      old_string: { type: 'string' },
      new_string: { type: 'string' },
      replace_all: { type: 'boolean' },
    }, ['path', 'old_string', 'new_string']),
  machineTool('orbit_machine_find', 'find',
    'Tìm tệp trên máy khác theo mẫu glob ("**/*.cs", "Assets/**/Player*.prefab"), và tuỳ chọn theo chữ bên trong (biểu thức '
    + 'chính quy, trả đường dẫn:dòng: nội dung). Bỏ qua .git, node_modules, Library, Temp, obj.',
    {
      path: { type: 'string', description: 'Thư mục gốc để tìm, đường dẫn tuyệt đối trên máy đích' },
      pattern: { type: 'string', description: 'Mẫu glob tính từ thư mục gốc (mặc định **/*)' },
      contains: { type: 'string', description: 'Biểu thức chính quy cần có trong tệp (không phân biệt hoa thường)' },
      max_results: { type: 'number', description: 'Số kết quả tối đa (mặc định 100, tối đa 500)' },
    }, ['path']),
  machineTool('orbit_machine_screen', 'screen',
    'Chụp màn hình của máy khác (Windows), trả ảnh để nhìn. Ảnh thu cho cạnh dài tối đa 1568 điểm; toạ độ dùng cho '
    + 'orbit_machine_input tính theo đúng ảnh này. Máy nhiều màn thì chọn bằng screen.',
    {
      screen: { type: 'number', description: 'Số màn (mặc định màn chính)' },
    }),
  machineTool('orbit_machine_input', 'input',
    'Bấm chuột, gõ phím trên máy khác (Windows), toạ độ theo ảnh của orbit_machine_screen cùng màn. Thao tác lần lượt: '
    + '{type:"click"|"double_click", x, y, button?: "left"|"right"|"middle"}, {type:"move", x, y}, {type:"drag", x, y, to_x, to_y}, '
    + '{type:"scroll", x, y, dy} (dy dương cuộn lên, âm cuộn xuống, 120 là một nấc), {type:"type", text}, '
    + '{type:"key", keys: "ctrl+s" | "enter" | "alt+tab" | "f5"}. screenshot: true thì chụp lại sau khi làm xong.',
    {
      screen: { type: 'number', description: 'Số màn (mặc định màn chính)' },
      actions: { type: 'array', items: { type: 'object' }, description: 'Các thao tác, tối đa 50' },
      screenshot: { type: 'boolean', description: 'Chụp màn hình sau khi làm xong' },
    }, ['actions']),
  machineTool('orbit_machine_unity', 'unity',
    'Gọi Orbit Unity MCP trên máy khác (vỏ dòng lệnh cli.mjs; máy đích khai đường dẫn tới cli.mjs bằng biến môi trường ORBIT_UNITY_MCP_CLI): ["list"] các Editor đang mở, ["ping", "--project", "<thư mục project>"], '
    + '["logs", "--project", "<p>"], ["exec", "--project", "<p>", "--code", "<C#>"], ["recipes"], ["recipe", "<tên>", ...]. '
    + 'Mỗi phần tử là một tham số riêng, không cần đặt ngoặc kép.',
    {
      args: { type: 'array', items: { type: 'string' }, description: 'Tham số của cli.mjs' },
    }, ['args']),
);

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function handle(request) {
  const { id, method, params } = request;
  switch (method) {
    case 'initialize':
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'orbit-remote', version: '0.1.0' },
        },
      });
      return;
    case 'notifications/initialized':
    case 'initialized':
      return;
    case 'ping':
      send({ jsonrpc: '2.0', id, result: {} });
      return;
    case 'tools/list':
      send({
        jsonrpc: '2.0',
        id,
        result: { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) },
      });
      return;
    case 'tools/call': {
      const tool = BY_NAME.get(params?.name);
      if (!tool) {
        send({ jsonrpc: '2.0', id, error: { code: -32602, message: `Không có công cụ ${params?.name}` } });
        return;
      }
      try {
        const value = await tool.run(params?.arguments || {});
        // Công cụ làm việc trên máy khác trả { text, image? }: đưa chữ và ảnh thật cho Claude, không bọc JSON.
        const content = tool.rich && value && typeof value.text === 'string'
          ? [...(value.image?.data ? [{ type: 'image', data: value.image.data, mimeType: value.image.mime || 'image/jpeg' }] : []), { type: 'text', text: value.text }]
          : [{ type: 'text', text: JSON.stringify(value, null, 2) }];
        send({ jsonrpc: '2.0', id, result: { content } });
      } catch (err) {
        send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Hỏng: ${err.message}` }], isError: true } });
      }
      return;
    }
    default:
      if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Chưa hỗ trợ ${method}` } });
  }
}

const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const text = line.trim();
  if (!text) return;
  let request;
  try {
    request = JSON.parse(text);
  } catch {
    process.stderr.write(`bỏ qua dòng không phải JSON: ${text.slice(0, 200)}\n`);
    return;
  }
  handle(request).catch((err) => {
    if (request.id !== undefined) send({ jsonrpc: '2.0', id: request.id, error: { code: -32603, message: err.message } });
  });
});
lines.on('close', () => process.exit(0));
