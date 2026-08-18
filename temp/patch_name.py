import re

path = r"C:\Users\MD\Desktop\DM_LLM_Portable\app\server.py"
with open(path, "r", encoding="utf-8") as f:
    src = f.read()

lines = src.split("\n")
start_idx = None
end_idx = None
for i, line in enumerate(lines):
    if "def generate_name" in line:
        start_idx = i
    if start_idx is not None and i > start_idx + 1 and line.strip().startswith("def ") and "generate_name" not in line:
        end_idx = i
        break
if end_idx is None:
    end_idx = len(lines)

T = chr(60) + "im_start" + chr(62)
TE = chr(60) + "im_end" + chr(62)

new_body = [
    "    name_parts = []",
    "    for m in messages[-6:]:",
    "        role = m.get('role', 'user')",
    "        content = m.get('content', '')",
    "        if isinstance(content, list):",
    "            texts = [p.get('text', '') for p in content if p.get('type') == 'text']",
    "            content = ' '.join(texts)",
    "        if content:",
    "            name_parts.append(role + ': ' + content[:200])",
    "",
    "    if not name_parts:",
    "        return jsonify({'success': True, 'name': 'Новый чат'})",
    "",
    "    conversation = chr(10).join(name_parts)",
    "",
    "    sys_prompt = ('Ты создаешь короткое название для чата по истории сообщений. '",
    "        'Ответь ТОЛЬКО одним коротким названием на русском языке (макс 5 слов). '",
    "        'Без кавычек, без знаков препинания, без объяснений.')",
    "",
    "    prompt_parts = []",
    "    prompt_parts.append(T + 'system' + chr(10) + sys_prompt + chr(10) + TE)",
    "    for np in name_parts:",
    "        r = np.split(': ', 1)[0]",
    "        c = np.split(': ', 1)[1] if ': ' in np else np",
    "        prompt_parts.append(T + r + chr(10) + c + chr(10) + TE)",
    "    prompt_parts.append(T + 'assistant' + chr(10))",
    "",
    "    prompt = ''.join(prompt_parts)",
    "",
    "    try:",
    "        tokens = llm.tokenize(prompt.encode('utf-8'))",
    "        if len(tokens) > 2048:",
    "            prompt_tokens = tokens[-2048:]",
    "        else:",
    "            prompt_tokens = tokens",
    "",
    "        output = llm.create_completion(",
    "            prompt=llm.detokenize(prompt_tokens),",
    "            max_tokens=60,",
    "            temperature=0.3,",
    "            top_p=0.9,",
    "            stream=False",
    "        )",
    "",
    "        name = output['choices'][0]['text'].strip()",
    "        name = re.sub(chr(60) + 'think.*?' + chr(62), '', name, flags=re.DOTALL).strip()",
    "        name = re.sub(chr(60) + 'think.*', '', name, flags=re.DOTALL).strip()",
    "        name = name.replace(chr(34), '').replace(chr(39), '').replace(chr(10), '').strip()",
    "        if len(name) > 40:",
    "            name = name[:40]",
    "        if not name:",
    "            name = 'Диалог'",
    "",
    "        logger.info(f'Generated chat name: {name}')",
    "        return jsonify({'success': True, 'name': name})",
    "",
    "    except Exception as e:",
    "        logger.error(f'Name generation error: {e}')",
    "        return jsonify({'success': True, 'name': 'Диалог'})",
]

result = "\n".join(lines[:start_idx]) + "\n" + "\n".join(new_body) + "\n" + "\n".join(lines[end_idx:])

with open(path, "w", encoding="utf-8") as f:
    f.write(result)

print("Patch applied successfully")