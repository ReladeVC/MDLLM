#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""MD LLM Server v5.5.0 - Refactored"""

import os
import sys
import signal
import time
import json
import traceback
import socket
import uuid
import logging
import gc
import subprocess
import shutil
import threading
import base64
import ctypes
import re
from contextlib import contextmanager, redirect_stdout, redirect_stderr
from typing import Optional, Dict, Any, List, Tuple
from pathlib import Path

if sys.platform == 'win32':
    try:
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
        sys.stderr.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass

# Добавляем директорию app в sys.path для поиска модулей
_APP_DIR = Path(__file__).parent.resolve()
if str(_APP_DIR) not in sys.path:
    sys.path.insert(0, str(_APP_DIR))

# ============================================================
# ИМПОРТЫ МОДУЛЕЙ ПРОЕКТА (ПЕРЕД setup_cuda)
# ============================================================
from config import (
    APP_DIR, BASE_DIR, MODELS_DIR, USER_DATA_DIR, UPLOADS_DIR,
    CACHE_DIR, TEMP_DIR, AppConfig, load_gen_params, save_gen_params,
    DEFAULT_GEN_PARAMS, setup_cuda_environment
)

setup_cuda_environment()

from model_manager import (
    ModelState, ThreadSafeModel, ModelManager,
    find_models, find_mmproj_files, get_model_requirements
)
from vision_handler import (
    MTMD_AVAILABLE, mtmd_cpp, register_vision_handler,
    create_mtmd_context, decode_image, create_bitmap, free_bitmap, free_chunks
)
from stream_manager import StreamManager, format_sse_event, format_sse_done, format_sse_error

# ============================================================
# ИМПОРТЫ БИБЛИОТЕК
# ============================================================
try:
    from llama_cpp import Llama as LlamaClass
    LLAMA_AVAILABLE = True
except ImportError:
    LLAMA_AVAILABLE = False

try:
    import psutil
    PSUTIL_AVAILABLE = True
except ImportError:
    PSUTIL_AVAILABLE = False

try:
    from flask import Flask, request, jsonify, Response, send_from_directory, send_file
    from flask_cors import CORS
except ImportError as e:
    print(f"Flask import error: {e}")
    print("pip install flask flask-cors")
    sys.exit(1)

# ============================================================
# НАСТРОЙКА ЛОГИРОВАНИЯ
# ============================================================
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s | %(name)s | %(levelname)-7s | %(message)s',
    datefmt='%H:%M:%S'
)
logger = logging.getLogger('MD_LLM')
logging.getLogger('werkzeug').setLevel(logging.ERROR)
logging.getLogger('flask').setLevel(logging.ERROR)
os.environ["GGML_LOG_LEVEL"] = "3"
os.environ["CLIP_VERBOSE"] = "0"
os.environ["LLAMA_LOG_LEVEL"] = "3"
os.environ["LLAMA_CPP_LOG_LEVEL"] = "3"

# ============================================================
# ГЛОБАЛЬНЫЕ ОБЪЕКТЫ
# ============================================================
config = AppConfig()
config.load_from_file()

state = ModelState()
model_lock = ThreadSafeModel(timeout=config.limits.request_timeout)
model_manager = ModelManager(state, model_lock)
stream_manager = StreamManager(timeout=config.limits.stream_timeout)
gen_params = load_gen_params(USER_DATA_DIR)

# ============================================================
# ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
# ============================================================
def get_local_ip() -> str:
    """Получение локального IP адреса"""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.settimeout(0.5)
            s.connect(("8.8.8.8", 80))
            return s.getsockname()[0]
    except:
        try:
            hostname = socket.gethostname()
            return socket.gethostbyname(hostname)
        except:
            return "127.0.0.1"

def safe_filename(filename: str) -> str:
    """Безопасное имя файла"""
    import re
    safe = re.sub(r'[<>:"/\\|?*]', '_', filename)
    safe = re.sub(r'\.\.', '', safe)
    safe = re.sub(r'^\.+', '', safe)
    return safe[:255]

def get_ram_stats() -> Dict[str, int]:
    """Получение статистики RAM"""
    result = {'total_mb': 0, 'used_mb': 0, 'free_mb': 0, 'percent': 0}
    
    if sys.platform == 'win32':
        try:
            class MEMORYSTATUSEX(ctypes.Structure):
                _fields_ = [
                    ("dwLength", ctypes.c_ulong),
                    ("dwMemoryLoad", ctypes.c_ulong),
                    ("ullTotalPhys", ctypes.c_ulonglong),
                    ("ullAvailPhys", ctypes.c_ulonglong),
                    ("ullTotalPageFile", ctypes.c_ulonglong),
                    ("ullAvailPageFile", ctypes.c_ulonglong),
                    ("ullTotalVirtual", ctypes.c_ulonglong),
                    ("ullAvailVirtual", ctypes.c_ulonglong),
                    ("sullAvailExtendedVirtual", ctypes.c_ulonglong)
                ]
            
            stat = MEMORYSTATUSEX()
            stat.dwLength = ctypes.sizeof(MEMORYSTATUSEX)
            
            if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(stat)):
                total = int(stat.ullTotalPhys / (1024*1024))
                free = int(stat.ullAvailPhys / (1024*1024))
                result = {
                    'total_mb': total,
                    'used_mb': total - free,
                    'free_mb': free,
                    'percent': int(stat.dwMemoryLoad)
                }
        except Exception as e:
            logger.debug(f"Windows RAM detection failed: {e}")
    
    elif PSUTIL_AVAILABLE:
        try:
            vm = psutil.virtual_memory()
            result = {
                'total_mb': int(vm.total / (1024*1024)),
                'used_mb': int(vm.used / (1024*1024)),
                'free_mb': int(vm.available / (1024*1024)),
                'percent': int(vm.percent)
            }
        except Exception as e:
            logger.debug(f"psutil RAM detection failed: {e}")
    
    elif sys.platform == 'linux':
        try:
            with open('/proc/meminfo', 'r') as f:
                for line in f:
                    if line.startswith('MemTotal:'):
                        total_kb = int(line.split()[1])
                        result['total_mb'] = total_kb // 1024
                    elif line.startswith('MemAvailable:'):
                        avail_kb = int(line.split()[1])
                        result['free_mb'] = avail_kb // 1024
            if result['total_mb'] > 0:
                result['used_mb'] = result['total_mb'] - result['free_mb']
                result['percent'] = int((result['used_mb'] / result['total_mb']) * 100)
        except Exception as e:
            logger.debug(f"Linux RAM detection failed: {e}")
    
    return result

def get_gpu_stats() -> List[Dict[str, Any]]:
    """Получение статистики GPU"""
    gpus = []
    
    # NVIDIA GPU
    nvidia_smi = shutil.which('nvidia-smi')
    if nvidia_smi:
        try:
            result = subprocess.run(
                [nvidia_smi, '--query-gpu=index,name,memory.total,memory.used,memory.free,utilization.gpu,temperature.gpu',
                 '--format=csv,noheader,nounits'],
                capture_output=True, text=True, timeout=5
            )
            
            if result.returncode == 0 and result.stdout:
                for line in result.stdout.strip().split('\n'):
                    parts = [p.strip() for p in line.split(',')]
                    if len(parts) >= 6:
                        gpu = {
                            'id': int(parts[0]),
                            'name': parts[1],
                            'mem_total_mb': int(float(parts[2])),
                            'mem_used_mb': int(float(parts[3])),
                            'mem_free_mb': int(float(parts[4])),
                            'util_percent': int(float(parts[5]))
                        }
                        if len(parts) > 6:
                            gpu['temperature_c'] = int(float(parts[6]))
                        gpus.append(gpu)
        except Exception as e:
            logger.debug(f"nvidia-smi failed: {e}")
    
    return gpus

def format_prompt(messages: List[Dict], system_prompt: str, think: bool) -> str:
    """Форматирование промпта для моделей"""
    prompt_parts = []
    
    if system_prompt:
        prompt_parts.append(f"<|im_start|>system\n{system_prompt}\n<|im_end|>\n")
    
    for msg in messages:
        content = msg.get('content', '')
        if isinstance(content, list):
            text_parts = [p.get('text', '') for p in content if p.get('type') == 'text']
            content = '\n'.join(text_parts)
        prompt_parts.append(f"<|im_start|>{msg['role']}\n{content}\n<|im_end|>\n")
    
    prompt_parts.append("<|im_start|>assistant\n")
    
    if think:
        prompt_parts.append("<think>\n")
    else:
        prompt_parts.append("<think>\n</think>\n\n")
    
    return ''.join(prompt_parts)

# ============================================================
# FLASK APP
# ============================================================
app = Flask(__name__, static_folder=str(APP_DIR / 'static'), static_url_path='/static')
app.config['MAX_CONTENT_LENGTH'] = config.limits.max_upload_size_bytes
app.config['SECRET_KEY'] = config.secret_key
app.config['SEND_FILE_MAX_AGE_DEFAULT'] = 3600
CORS(app, resources={r"/*": {"origins": "*"}})

app.start_time = time.time()

# ============================================================
# API ENDPOINTS
# ============================================================
@app.route('/')
def index():
    """Главная страница"""
    return send_from_directory(str(APP_DIR), 'index.html')

@app.route('/static/<path:path>')
def serve_static(path):
    """Статические файлы"""
    resp = send_from_directory(str(APP_DIR / 'static'), path)
    resp.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0'
    return resp

@app.route('/health')
def health_check():
    """Проверка здоровья"""
    llm = state.get_llm()
    return jsonify({
        'status': 'ok',
        'version': '5.5.0',
        'port': config.server.port,
        'model_loaded': llm is not None,
        'model_name': state.current_model,
        'gpu_enabled': state.gpu_enabled,
        'gpu_layers': state.gpu_layers,
        'vision_active': state.chat_handler is not None,
        'handler_type': state.handler_type,
        'llama_available': LLAMA_AVAILABLE,
        'mtmd_available': MTMD_AVAILABLE,
        'active_streams': stream_manager.active_count,
        'uptime_seconds': round(time.time() - app.start_time, 1)
    })

@app.route('/api/models')
def api_list_models():
    """Список моделей"""
    return jsonify({
        'success': True,
        'models': find_models(MODELS_DIR),
        'mmproj_files': find_mmproj_files(MODELS_DIR),
        'current_model': state.current_model,
        'current_mmproj': state.current_mmproj,
        'model_loaded': state.llm is not None,
        'gpu_enabled': state.gpu_enabled,
        'vision_active': state.chat_handler is not None
    })

@app.route('/api/model/info')
def model_info():
    """Информация о загруженной модели"""
    if not state.llm:
        return jsonify({'error': 'Модель не загружена'}), 400
    
    llm = state.get_llm()
    return jsonify({
        'success': True,
        'info': {
            'name': state.current_model,
            'gpu_enabled': state.gpu_enabled,
            'gpu_layers': state.gpu_layers,
            'n_ctx': state.n_ctx,
            'n_batch': state.n_batch,
            'vocab_size': getattr(llm, 'n_vocab', None),
            'load_time': state.load_time,
            'last_used': state.last_used
        }
    })

@app.route('/api/model/requirements', methods=['POST'])
def model_requirements():
    """Требования к памяти для модели"""
    data = request.json or {}
    model_name = data.get('model_name')
    n_ctx = int(data.get('n_ctx', 8192))
    
    if not model_name:
        return jsonify({'error': 'model_name required'}), 400
    
    model_path = MODELS_DIR / model_name
    if not model_path.exists():
        return jsonify({'error': 'Model not found'}), 404
    
    requirements = get_model_requirements(model_path, n_ctx)
    return jsonify({'success': True, 'requirements': requirements})

@app.route('/api/unload_model', methods=['POST'])
def unload_model():
    """Выгрузка модели"""
    try:
        if state.llm:
            logger.info(f"Unloading model: {state.current_model}")
            state.clear()
            gc.collect()
            return jsonify({'success': True, 'message': 'Модель выгружена'})
        return jsonify({'success': True, 'message': 'Модель не была загружена'})
    except Exception as e:
        logger.error(f"Unload error: {e}")
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/load_model', methods=['POST'])
def load_model():
    """Загрузка модели"""
    if not LLAMA_AVAILABLE:
        return jsonify({'error': 'llama_cpp не установлен. Установите: pip install llama-cpp-python'}), 500
    
    data = request.json or {}
    model_name = data.get('model_name')
    
    if not model_name:
        return jsonify({'error': 'model_name required'}), 400
    
    model_path = MODELS_DIR / model_name
    if not model_path.exists():
        return jsonify({'error': f'Модель не найдена: {model_name}'}), 404
    
    try:
        # Очистка перед загрузкой
        state.clear()
        
        use_gpu = data.get('use_gpu', True)
        n_ctx = int(data.get('n_ctx', gen_params.get('n_ctx', 8192)))
        n_batch = int(data.get('n_batch', gen_params.get('n_batch', 4096)))
        n_threads = int(data.get('n_threads', gen_params.get('n_threads', 4)))
        n_threads_batch = int(data.get('n_threads_batch', gen_params.get('n_threads_batch', 4)))
        n_gpu_layers = int(data.get('n_gpu_layers', gen_params.get('n_gpu_layers', -1)))
        flash_attn = bool(data.get('flash_attn', gen_params.get('flash_attn', True)))
        
        kwargs = {
            'model_path': str(model_path),
            'n_ctx': n_ctx,
            'n_batch': n_batch,
            'n_threads': n_threads,
            'n_threads_batch': n_threads_batch,
            'n_gpu_layers': n_gpu_layers if use_gpu else 0,
            'use_mmap': True,
            'use_mlock': False,
            'verbose': False,
            'flash_attn': flash_attn and use_gpu,
            'last_n_tokens_size': -1
        }
        
        logger.info(f"Loading model: {model_name}")
        logger.info(f"  Context: {n_ctx}, Batch: {n_batch}")
        if use_gpu:
            logger.info(f"  GPU layers: {n_gpu_layers}")
        
        start_time = time.time()
        
        # Подавляем вывод от llama.cpp
        with open(os.devnull, 'w') as devnull:
            with redirect_stdout(devnull), redirect_stderr(devnull):
                llm = LlamaClass(**kwargs)
        
        elapsed = round(time.time() - start_time, 2)
        
        state.update(
            llm=llm,
            current_model=model_name,
            current_model_path=model_path,
            gpu_enabled=use_gpu,
            gpu_layers=n_gpu_layers if use_gpu else 0,
            n_ctx=n_ctx,
            n_batch=n_batch,
            load_time=elapsed
        )
        
        logger.info(f"✅ Model loaded in {elapsed}s")
        
        if state.current_mmproj:
            mmproj_path = MODELS_DIR / state.current_mmproj
            if mmproj_path.exists():
                with open(os.devnull, 'w') as devnull:
                    with redirect_stdout(devnull), redirect_stderr(devnull):
                        handler, htype = register_vision_handler(state.llm, mmproj_path, model_name)
                state.update(chat_handler=handler, handler_type=htype)
                if not handler:
                    state.update(current_mmproj=None)
        
        return jsonify({
            'success': True,
            'model': model_name,
            'gpu_enabled': use_gpu,
            'n_gpu_layers': n_gpu_layers if use_gpu else 0,
            'n_ctx': n_ctx,
            'n_batch': n_batch,
            'flash_attn': flash_attn and use_gpu,
            'load_time': elapsed,
            'vision_active': state.chat_handler is not None,
            'handler_type': state.handler_type
        })
        
    except MemoryError:
        logger.error("Memory error while loading model")
        return jsonify({'error': 'Недостаточно памяти для загрузки модели'}), 507
    except Exception as e:
        logger.error(f"Load error: {traceback.format_exc()}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/load_mmproj', methods=['POST'])
def load_mmproj():
    """Загрузка mmproj файла для vision"""
    if not state.llm:
        return jsonify({'error': 'Сначала загрузите основную модель'}), 400
    
    if not MTMD_AVAILABLE:
        return jsonify({'error': 'mtmd_cpp не доступен'}), 400
    
    data = request.json or {}
    filename = data.get('filename', '')
    
    # Отключение vision
    if not filename:
        state.update(
            chat_handler=None,
            current_mmproj=None,
            handler_type=None
        )
        if state.mtmd_ctx and mtmd_cpp:
            try:
                mtmd_cpp.mtmd_free(state.mtmd_ctx)
            except:
                pass
            state.mtmd_ctx = None
        return jsonify({'success': True, 'vision_active': False})
    
    # Загрузка mmproj
    filepath = MODELS_DIR / filename
    if not filepath.exists():
        return jsonify({'error': f'Файл не найден: {filename}'}), 404
    
    try:
        if state.mtmd_ctx:
            try: mtmd_cpp.mtmd_free(state.mtmd_ctx)
            except: pass
            state.mtmd_ctx = None
        with open(os.devnull, 'w') as devnull:
            with redirect_stdout(devnull), redirect_stderr(devnull):
                handler, htype = register_vision_handler(state.llm, filepath, state.current_model)
        if not handler:
            raise RuntimeError("Failed to create vision handler.")
        state.update(
            current_mmproj=filename,
            handler_type=htype,
            chat_handler=handler
        )
        
        logger.info(f"mmproj loaded: {filename} (type: {htype})")
        
        return jsonify({
            'success': True,
            'mmproj': filename,
            'vision_active': True,
            'handler_type': htype
        })
        
    except Exception as e:
        logger.error(f"Load mmproj error: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/gen_params', methods=['GET'])
def get_gen_params():
    """Получение параметров генерации"""
    return jsonify({'success': True, 'params': gen_params})

@app.route('/api/gen_params', methods=['POST'])
def update_gen_params():
    """Обновление параметров генерации"""
    global gen_params
    try:
        data = request.json
        if not data:
            return jsonify({'success': False, 'error': 'No data'}), 400
        
        new_params = data.get('params', {})
        
        # Валидация параметров
        valid_params = {}
        for key, value in new_params.items():
            if key in DEFAULT_GEN_PARAMS:
                if isinstance(DEFAULT_GEN_PARAMS[key], bool):
                    valid_params[key] = bool(value)
                elif isinstance(DEFAULT_GEN_PARAMS[key], (int, float)):
                    valid_params[key] = type(DEFAULT_GEN_PARAMS[key])(value)
                else:
                    valid_params[key] = value
        
        gen_params.update(valid_params)
        save_gen_params(gen_params, USER_DATA_DIR)
        
        logger.info(f"Parameters updated: {len(valid_params)} changes")
        return jsonify({'success': True, 'params': gen_params})
        
    except Exception as e:
        logger.error(f"Update params error: {e}")
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/reset_params', methods=['POST'])
def reset_params():
    """Сброс параметров к значениям по умолчанию"""
    global gen_params
    gen_params = DEFAULT_GEN_PARAMS.copy()
    save_gen_params(gen_params, USER_DATA_DIR)
    logger.info("Parameters reset to defaults")
    return jsonify({'success': True, 'params': gen_params})

@app.route('/api/upload_image', methods=['POST'])
def upload_image():
    """Загрузка изображения"""
    try:
        # JSON с base64
        if request.is_json:
            data = request.json
            b64_data = data.get('image')
            if b64_data:
                if ',' in b64_data:
                    b64_data = b64_data.split(',')[1]
                
                # Проверка размера
                size_bytes = len(b64_data) * 3 // 4
                if size_bytes > config.limits.max_image_size_bytes:
                    return jsonify({'error': f'Image too large (max {config.limits.max_image_size_mb}MB)'}), 400
                
                return jsonify({
                    'success': True,
                    'image': f"data:image/png;base64,{b64_data}",
                    'size_kb': size_bytes // 1024
                })
            return jsonify({'error': 'No image data'}), 400
        
        # Файловая загрузка
        if 'file' not in request.files:
            return jsonify({'error': 'No file uploaded'}), 400
        
        file = request.files['file']
        if not file.filename:
            return jsonify({'error': 'Empty filename'}), 400
        
        # Проверка типа
        allowed_types = ['image/jpeg', 'image/png', 'image/gif', 'image/webp']
        if file.content_type not in allowed_types:
            return jsonify({'error': f'Unsupported file type. Allowed: {", ".join(allowed_types)}'}), 400
        
        content = file.read()
        
        # Проверка размера
        if len(content) > config.limits.max_image_size_bytes:
            return jsonify({'error': f'Image too large (max {config.limits.max_image_size_mb}MB)'}), 400
        
        # Конвертация в base64
        b64_data = base64.b64encode(content).decode('utf-8')
        mime = file.content_type or 'image/png'
        
        # Сохранение
        safe_name = f"{uuid.uuid4().hex[:8]}_{safe_filename(file.filename)}"
        with open(UPLOADS_DIR / safe_name, 'wb') as out:
            out.write(content)
        
        return jsonify({
            'success': True,
            'image': f"data:{mime};base64,{b64_data}",
            'filename': safe_name,
            'size_kb': len(content) // 1024,
            'mime_type': mime
        })
        
    except Exception as e:
        logger.error(f"Upload error: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/system_stats')
def system_stats():
    """Системная статистика"""
    return jsonify({
        'success': True,
        'stats': {
            'ram': get_ram_stats(),
            'gpus': get_gpu_stats(),
            'timestamp': time.time()
        }
    })

@app.route('/api/generate_name', methods=['POST'])
def generate_name():
    """Генерация краткого имени чата через модель"""
    llm = state.get_llm()
    if not llm:
        return jsonify({'success': False, 'error': 'Модель не загружена'}), 400

    data = request.json or {}
    messages = data.get('messages', [])
    if not messages:
        return jsonify({'success': True, 'name': 'Новый чат'})

    chat_messages = []
    for m in messages[-6:]:
        role = m.get('role', 'user')
        content = m.get('content', '')
        if isinstance(content, list):
            texts = [p.get('text', '') for p in content if p.get('type') == 'text']
            content = ' '.join(texts)
        if content:
            chat_messages.append({"role": role, "content": content[:200]})

    if not chat_messages:
        return jsonify({'success': True, 'name': 'Новый чат'})

    sys_prompt = ('Ты создаешь короткое название для чата по истории сообщений. '
        'Ответь ТОЛЬКО одним коротким названием на русском языке (макс 5 слов). '
        'Без кавычек, без знаков препинания, без объяснений.')

    chat_messages.insert(0, {"role": "system", "content": sys_prompt})

    try:
        output = llm.create_chat_completion(
            messages=chat_messages,
            max_tokens=60,
            temperature=0.3,
            top_p=0.9,
            stream=False
        )

        name = output['choices'][0]['message']['content'].strip()
        _ot = chr(60) + 'think' + chr(62)
        _ct = chr(60) + '/think' + chr(62)
        name = re.sub(_ot + '.*?' + _ct, '', name, flags=re.DOTALL).strip()
        name = re.sub(_ot + '.*', '', name, flags=re.DOTALL).strip()
        name = name.replace(chr(34), '').replace(chr(39), '').replace(chr(10), '').strip()
        if len(name) > 40:
            name = name[:40]
        if not name:
            name = 'Диалог'

        logger.info(f'Generated chat name: {name}')
        return jsonify({'success': True, 'name': name})

    except Exception as e:
        logger.error(f'Name generation error: {e}')
        return jsonify({'success': True, 'name': 'Диалог'})

def _run_vision_generation(llm, messages, images, system_prompt, data, stream_id, start_time):
    """Vision generation using raw mtmd API"""
    # ============================================================

    # === VISION РЕЖИМ (Think Tag Fix + Lazy Logits) ===

    # ============================================================

     
    # Сброс KV-кэша перед каждым Vision-запросом

    try: llm._ctx.kv_cache_clear()

    except AttributeError: pass

    try: llm.reset()

    except: pass

    llm.n_tokens = 0

    if hasattr(llm, 'input_ids'):

        try: llm.input_ids[:] = 0

        except: pass

    api_messages = []

    if system_prompt:

        api_messages.append({"role": "system", "content": system_prompt})

    for m in messages[:-1]:

        content = m['content']

        if isinstance(content, list):

            text_parts = [p.get('text', '') for p in content if p.get('type') == 'text']

            content = '\n'.join(text_parts) if text_parts else ''

        if content:

            api_messages.append({"role": m['role'], "content": content})

    user_content = []

    image_bytes_list = []

    for img_b64 in images:

        if img_b64.startswith('data:'):

            _, b64_data = img_b64.split(',', 1)

        else:

            b64_data = img_b64

        try:

            img_bytes = base64.b64decode(b64_data)

            image_bytes_list.append(img_bytes)

            user_content.append({"type": "image_url", "image_url": {"url": "data:image/png;base64," + b64_data}})

        except Exception as e:

            logger.error(f"Ошибка декодирования картинки: {e}")

    if messages and messages[-1]['role'] == 'user':

        last_content = messages[-1]['content']

        if isinstance(last_content, str) and last_content.strip():

            user_content.append({"type": "text", "text": last_content})

        elif isinstance(last_content, list):

            for p in last_content:

                if p.get('type') == 'text' and p.get('text', '').strip():

                    user_content.append(p)

    if not any(p.get('type') == 'text' for p in user_content):

        user_content.append({"type": "text", "text": "Опиши это изображение подробно."})

    api_messages.append({"role": "user", "content": user_content})

    logger.info("Vision MTMD: %d image(s), GPU=%s", len(image_bytes_list), state.gpu_enabled)

    mmproj_path = MODELS_DIR / state.current_mmproj

     
    if state.mtmd_ctx is not None:

        try: mtmd_cpp.mtmd_free(state.mtmd_ctx)

        except: pass

        state.mtmd_ctx = None

     
    with open(os.devnull, 'w') as devnull:
        with redirect_stdout(devnull), redirect_stderr(devnull):
            ctx = create_mtmd_context(llm, mmproj_path, use_gpu=state.gpu_enabled)

    media_marker = mtmd_cpp.mtmd_default_marker()

    if isinstance(media_marker, bytes):

        media_marker = media_marker.decode("utf-8")

    prompt_parts = []

    if system_prompt:

        prompt_parts.append("<|im_start|>system\n" + system_prompt + "\n<|im_end|>\n")

    for m in api_messages:

        role = m.get('role', 'user')

        content = m.get('content', '')

        if role == 'system':

            continue

        if isinstance(content, list):

            msg_parts = []

            for part in content:

                if part.get('type') == 'image_url':

                    msg_parts.append(media_marker)

                elif part.get('type') == 'text':

                    msg_parts.append(part.get('text', ''))

            content_str = ''.join(msg_parts)

        else:

            content_str = str(content)

        prompt_parts.append("<|im_start|>" + role + "\n" + content_str + "\n<|im_end|>\n")

    prompt_parts.append("<|im_start|>assistant\n")

     
    # 🔥 ИСПРАВЛЕНИЕ: Закрываем тег <think> если режим размышлений выключен

    if not data.get('think', False):

        prompt_parts.append("<think>\n</think>\n\n")

     
    prompt_text = ''.join(prompt_parts)

    bitmaps = []

    chunks = None

    actual_n_past = 0

    try:

        for img_bytes in image_bytes_list:

            buf_array = (ctypes.c_uint8 * len(img_bytes))(*img_bytes)

            bitmap = mtmd_cpp.mtmd_helper_bitmap_init_from_buf(ctx, buf_array, len(img_bytes))

            if not bitmap:

                raise RuntimeError("Не удалось создать bitmap")

            bitmaps.append(bitmap)

        input_text = mtmd_cpp.mtmd_input_text()

        input_text.text = prompt_text.encode("utf-8")

        input_text.add_special = True

        input_text.parse_special = True

        chunks = mtmd_cpp.mtmd_input_chunks_init()

        if not chunks:

            raise RuntimeError("Не удалось создать chunks")

        n_bitmaps = len(bitmaps)

        BitmapArray = mtmd_cpp.mtmd_bitmap_p_ctypes * max(n_bitmaps, 1)

        bitmap_array = BitmapArray(*bitmaps) if bitmaps else BitmapArray()

        tok_result = mtmd_cpp.mtmd_tokenize(

            ctx, chunks, ctypes.byref(input_text), bitmap_array, n_bitmaps

        )

        if tok_result != 0:

            raise RuntimeError("mtmd_tokenize ошибка: " + str(tok_result))

        n_chunks = mtmd_cpp.mtmd_input_chunks_size(chunks)

        logger.info("Токенизировано в %d chunks", n_chunks)

        # Очистка KV-кэша перед eval

        try: llm._ctx.kv_cache_clear()

        except AttributeError: pass

        llm.n_tokens = 0

        n_past = ctypes.c_int(0)

        llama_ctx = llm.ctx if hasattr(llm, 'ctx') else llm._ctx

        eval_result = mtmd_cpp.mtmd_helper_eval_chunks(

            ctx, llama_ctx, chunks,

            0, 0, llm.n_batch,

            True,  # logits_last=True

            ctypes.byref(n_past)

        )

        if eval_result != 0:

            raise RuntimeError("mtmd_helper_eval_chunks ошибка: " + str(eval_result))

        actual_n_past = n_past.value

        logger.info("Chunks оценены. n_past=%d", actual_n_past)

    finally:

        if chunks:

            try: mtmd_cpp.mtmd_input_chunks_free(chunks)

            except: pass

        for bitmap in bitmaps:

            if bitmap:

                try: mtmd_cpp.mtmd_bitmap_free(bitmap)

                except: pass

        gc.collect()

    # Синхронизация Python-состояния

    llm.n_tokens = actual_n_past

    if hasattr(llm, 'input_ids'):

        try:

            if actual_n_past > len(llm.input_ids):

                llm.input_ids = np.zeros(actual_n_past, dtype=np.intc)

            else:

                llm.input_ids[:actual_n_past] = 0

        except: pass

    # 🔥 LAZY LOGITS ACTIVATION

    sample_idx = actual_n_past - 1

    logits_activated = False

     
    logger.info("Готов к генерации. sample_idx=%d, n_tokens=%d", sample_idx, llm.n_tokens)

    # === ЦИКЛ SAMPLE + EVAL ===

    stop_tokens = set()

    for s in ["<|im_end|>"]:

        toks = llm.tokenize(s.encode("utf-8"), add_bos=False, special=True)

        stop_tokens.update(toks)

    stop_tokens.add(llm.token_eos())

    max_gen = int(data.get('max_tokens', gen_params['max_tokens']))

    token_count = 0

    temp = float(data.get('temperature', gen_params['temperature']))

    top_p_val = float(data.get('top_p', gen_params['top_p']))

    top_k_val = int(data.get('top_k', gen_params['top_k']))

    min_p_val = float(data.get('min_p', gen_params.get('min_p', 0.05)))

    repeat_pen = float(data.get('repeat_penalty', gen_params['repeat_penalty']))

    stream_manager.update_tokens(stream_id, 0)

    for gen_step in range(max_gen):

        if not stream_manager.is_active(stream_id):

            break

        try:

            token = llm.sample(

                top_k=top_k_val, top_p=top_p_val, min_p=min_p_val,

                temp=temp, repeat_penalty=repeat_pen,

                idx=sample_idx,

            )

        except Exception as e:

            # 🔥 FALLBACK: активируем логиты лениво

            if not logits_activated and actual_n_past > 0 and hasattr(llm, 'input_ids'):

                logger.info("Logits not ready, activating via last-token eval...")

                try:

                    last_token_id = int(llm.input_ids[actual_n_past - 1])

                    llm.eval([last_token_id])

                    sample_idx = llm.n_tokens - 1

                    logits_activated = True

                    token = llm.sample(

                        top_k=top_k_val, top_p=top_p_val, min_p=min_p_val,

                        temp=temp, repeat_penalty=repeat_pen,

                        idx=sample_idx,

                    )

                except Exception as e2:

                    logger.error("Fallback sample failed: %s", e2)

                    break

            else:

                logger.error("Ошибка семплинга на idx=%d: %s", sample_idx, e)

                break

        if token in stop_tokens:

            break

        token_count += 1

        piece = llm.detokenize([token]).decode("utf-8", errors="ignore")

        if piece:

            yield "data: " + json.dumps({'content': piece}) + "\n\n"

        llm.eval([token])

        sample_idx = llm.n_tokens - 1

    stream_manager.remove_stream(stream_id)

    gc.collect()

     
    elapsed = time.time() - start_time

    speed = token_count / elapsed if elapsed > 0 else 0

    yield "data: " + json.dumps({'usage': {

        'prompt_tokens': actual_n_past,

        'completion_tokens': token_count,

        'time_seconds': round(elapsed, 2),

        'tokens_per_second': round(speed, 2)

    }}) + "\n\n"

    yield "data: [DONE]\n\n"

    return

@app.route('/chat/stream', methods=['POST'])
def chat_stream():
    """Потоковый чат"""
    llm = state.get_llm()
    if not llm:
        return jsonify({'error': 'Модель не загружена'}), 400
    
    data = request.json or {}
    messages = data.get('messages', [])[-config.limits.max_history_messages:]
    system_prompt = data.get('system_prompt', '')
    think = data.get('think', False)
    images = data.get('images', [])
    stream_id = str(uuid.uuid4())
    
    # Параметры генерации
    temp = float(data.get('temperature', gen_params.get('temperature', 0.7)))
    max_tokens = int(data.get('max_tokens', gen_params.get('max_tokens', 2048)))
    top_p = float(data.get('top_p', gen_params.get('top_p', 0.95)))
    top_k = int(data.get('top_k', gen_params.get('top_k', 40)))
    repeat_penalty = float(data.get('repeat_penalty', gen_params.get('repeat_penalty', 1.1)))
    frequency_penalty = float(data.get('frequency_penalty', gen_params.get('frequency_penalty', 0.0)))
    presence_penalty = float(data.get('presence_penalty', gen_params.get('presence_penalty', 0.0)))
    
    def generate():
        start_time = time.time()
        use_vision = images and state.chat_handler and hasattr(state.chat_handler, '__call__')
        
        try:
            with model_lock.acquire():
                # Сброс состояния модели
                try:
                    if hasattr(llm, 'reset'):
                        llm.reset()
                    if hasattr(llm, '_ctx') and hasattr(llm._ctx, 'kv_cache_clear'):
                        llm._ctx.kv_cache_clear()
                except Exception as e:
                    logger.warning(f"Reset error: {e}")
                
                # Подготовка сообщений для vision API
                if use_vision:
                    chat_messages = []
                    if system_prompt:
                        chat_messages.append({'role': 'system', 'content': system_prompt})
                    for msg in messages:
                        m = {'role': msg['role'], 'content': msg.get('content', '')}
                        chat_messages.append(m)
                    for img_b64 in images:
                        if not chat_messages or chat_messages[-1]['role'] != 'user':
                            chat_messages.append({'role': 'user', 'content': []})
                        last_user = chat_messages[-1]
                        if isinstance(last_user['content'], str):
                            last_user['content'] = [{'type': 'text', 'text': last_user['content']}]
                        elif not isinstance(last_user['content'], list):
                            last_user['content'] = [{'type': 'text', 'text': ''}]
                        last_user['content'].append({
                            'type': 'image_url',
                            'image_url': {'url': img_b64 if img_b64.startswith('data:') else f'data:image/png;base64,{img_b64}'}
                        })
                    if think:
                        if chat_messages and chat_messages[-1]['role'] == 'user':
                            last_c = chat_messages[-1]['content']
                            if isinstance(last_c, list):
                                for part in last_c:
                                    if part.get('type') == 'text':
                                        part['text'] = part['text'] + '\n\nPlease think step by step.'
                                        break
                            elif isinstance(last_c, str):
                                chat_messages[-1]['content'] = last_c + '\n\nPlease think step by step.'
                    prompt_tokens = 0
                    for m in chat_messages:
                        c = m.get('content', '')
                        if isinstance(c, str):
                            prompt_tokens += len(c) // 4
                        elif isinstance(c, list):
                            for p in c:
                                if p.get('type') == 'text':
                                    prompt_tokens += len(p.get('text', '')) // 4
                                elif p.get('type') == 'image_url':
                                    prompt_tokens += 1000
                    logger.info(f"Stream {stream_id}: ~{prompt_tokens} prompt tokens (vision mode)")
                else:
                    prompt = format_prompt(messages, system_prompt, think)
                    prompt_tokens = len(llm.tokenize(prompt.encode('utf-8')))
                    logger.info(f"Stream {stream_id}: {prompt_tokens} prompt tokens")
                
                # Регистрация стрима
                stream_manager.create_stream(stream_id)
                
                # Генерация
                if use_vision:
                    yield from _run_vision_generation(llm, messages, images, system_prompt, data, stream_id, start_time)
                    stream_manager.remove_stream(stream_id)
                    return
                else:
                    stream = llm.create_completion(
                        prompt=prompt,
                        temperature=temp,
                        max_tokens=max_tokens,
                        top_p=top_p,
                        top_k=top_k,
                        repeat_penalty=repeat_penalty,
                        frequency_penalty=frequency_penalty,
                        presence_penalty=presence_penalty,
                        stream=True,
                    stop=["<|im_end|>", "<|eot_id|>"],
                        echo=False
                    )

                if stream is None:
                    yield f"data: {json.dumps({'error': 'Vision processing failed'})}\n\n"
                    yield "data: [DONE]\n\n"
                    return
                
                token_count = 0
                for chunk in stream:
                    if not stream_manager.is_active(stream_id):
                        break
                    
                    choices = chunk.get('choices', [])
                    if choices:
                        delta = choices[0].get('delta', {})
                        text = delta.get('content', '') or choices[0].get('text', '')
                        if text:
                            token_count += 1
                            stream_manager.update_tokens(stream_id, token_count)
                            yield f"data: {json.dumps({'content': text})}\n\n"
                
                # Статистика
                elapsed = time.time() - start_time
                speed = token_count / elapsed if elapsed > 0 else 0
                
                usage_data = {
                    'usage': {
                        'prompt_tokens': prompt_tokens,
                        'completion_tokens': token_count,
                        'time_seconds': round(elapsed, 2),
                        'tokens_per_second': round(speed, 2)
                    }
                }
                yield f"data: {json.dumps(usage_data)}\n\n"
                
                yield "data: [DONE]\n\n"
                
        except TimeoutError as e:
            logger.error(f"Timeout error: {e}")
            yield f"data: {json.dumps({'error': str(e)})}\n\n"
            yield "data: [DONE]\n\n"
        except Exception as e:
            logger.error(f"Stream error: {traceback.format_exc()}")
            yield f"data: {json.dumps({'error': str(e)})}\n\n"
            yield "data: [DONE]\n\n"
        finally:
            stream_manager.remove_stream(stream_id)
    
    resp = Response(generate(), mimetype='text/event-stream')
    resp.headers['Cache-Control'] = 'no-cache'
    resp.headers['X-Accel-Buffering'] = 'no'
    resp.headers['Connection'] = 'keep-alive'
    return resp

@app.route('/api/stop_stream/<stream_id>', methods=['POST'])
def stop_stream(stream_id):
    """Остановка потока"""
    if stream_manager.stop_stream(stream_id):
        return jsonify({'success': True, 'message': 'Stream stopped'})
    return jsonify({'success': False, 'message': 'Stream not found'}), 404

@app.route('/api/toggle_gpu', methods=['POST'])
def toggle_gpu():
    """Переключение GPU/CPU с перезагрузкой модели"""
    data = request.json or {}
    use_gpu = data.get('gpu_enabled', True)

    if not state.llm or not state.current_model:
        state.gpu_enabled = use_gpu
        return jsonify({'success': True, 'gpu_enabled': use_gpu, 'message': 'No model loaded, GPU preference saved'})

    result = model_manager.toggle_gpu(use_gpu)
    if 'error' in result:
        return jsonify(result), 500
    return jsonify(result)

@app.route('/api/active_streams')
def get_active_streams():
    """Список активных потоков"""
    streams = stream_manager.get_all_active()
    return jsonify({'success': True, 'streams': streams, 'count': len(streams)})

@app.route('/api/save_data', methods=['POST'])
def save_data():
    """Сохранение данных"""
    try:
        data = request.json or {}
        key = data.get('key', '')
        value = data.get('data')
        
        if not key:
            return jsonify({'success': False, 'error': 'Key required'}), 400
        
        safe_key = safe_filename(key)
        file_path = USER_DATA_DIR / f"{safe_key}.json"
        
        payload = {
            'data': value,
            'metadata': {
                'saved_at': time.time(),
                'version': '5.5.0',
                'key': key
            }
        }
        
        with open(file_path, 'w', encoding='utf-8') as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
        
        logger.info(f"Data saved: {key}")
        return jsonify({'success': True})
        
    except Exception as e:
        logger.error(f"Save error: {e}")
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/load_data/<key>')
def load_data(key):
    """Загрузка данных"""
    try:
        safe_key = safe_filename(key)
        file_path = USER_DATA_DIR / f"{safe_key}.json"
        
        if not file_path.exists():
            return jsonify({'success': False, 'data': None, 'exists': False})
        
        with open(file_path, 'r', encoding='utf-8') as f:
            raw = json.load(f)
        
        if isinstance(raw, dict) and 'data' in raw:
            data = raw['data']
            metadata = raw.get('metadata', {})
        elif isinstance(raw, list):
            data = raw
            metadata = {}
        else:
            data = raw
            metadata = {}
        
        return jsonify({
            'success': True,
            'data': data,
            'metadata': metadata,
            'exists': True
        })
        
    except Exception as e:
        logger.error(f"Load error: {e}")
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/delete_data/<key>', methods=['DELETE'])
def delete_data(key):
    """Удаление данных"""
    try:
        safe_key = safe_filename(key)
        file_path = USER_DATA_DIR / f"{safe_key}.json"
        
        if file_path.exists():
            file_path.unlink()
            logger.info(f"Data deleted: {key}")
            return jsonify({'success': True, 'deleted': True})
        
        return jsonify({'success': True, 'deleted': False})
        
    except Exception as e:
        logger.error(f"Delete error: {e}")
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/list_data')
def list_data():
    """Список сохраненных данных"""
    try:
        files = []
        for file_path in USER_DATA_DIR.glob('*.json'):
            if file_path.stem != 'modelGenParams':
                try:
                    with open(file_path, 'r', encoding='utf-8') as f:
                        data = json.load(f)
                        files.append({
                            'key': file_path.stem,
                            'saved_at': data.get('metadata', {}).get('saved_at', file_path.stat().st_mtime),
                            'size_kb': file_path.stat().st_size // 1024
                        })
                except:
                    files.append({
                        'key': file_path.stem,
                        'saved_at': file_path.stat().st_mtime,
                        'size_kb': file_path.stat().st_size // 1024
                    })
        
        files.sort(key=lambda x: x['saved_at'], reverse=True)
        return jsonify({'success': True, 'files': files})
        
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/export_all_data')
def export_all_data():
    """Экспорт всех данных"""
    try:
        all_data = {}
        for file_path in USER_DATA_DIR.glob('*.json'):
            if file_path.stem != 'modelGenParams':
                try:
                    with open(file_path, 'r', encoding='utf-8') as f:
                        all_data[file_path.stem] = json.load(f)
                except Exception as e:
                    logger.warning(f"Failed to export {file_path}: {e}")
        
        return jsonify({
            'success': True,
            'data': all_data,
            'exported_at': time.time(),
            'count': len(all_data)
        })
        
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/import_data', methods=['POST'])
def import_data():
    """Импорт данных"""
    try:
        data = request.json or {}
        imported_data = data.get('data', {})
        overwrite = data.get('overwrite', True)
        
        imported_count = 0
        skipped_count = 0
        
        for key, value in imported_data.items():
            safe_key = safe_filename(key)
            file_path = USER_DATA_DIR / f"{safe_key}.json"
            
            if file_path.exists() and not overwrite:
                skipped_count += 1
                continue
            
            with open(file_path, 'w', encoding='utf-8') as f:
                json.dump(value, f, ensure_ascii=False, indent=2)
            imported_count += 1
        
        logger.info(f"Imported {imported_count} files, skipped {skipped_count}")
        
        return jsonify({
            'success': True,
            'imported': imported_count,
            'skipped': skipped_count
        })
        
    except Exception as e:
        logger.error(f"Import error: {e}")
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/clear_cache', methods=['POST'])
def clear_cache():
    """Очистка кэша"""
    try:
        # Очистка temp директории
        for file_path in TEMP_DIR.glob('*'):
            try:
                if file_path.is_file():
                    file_path.unlink()
                elif file_path.is_dir():
                    shutil.rmtree(file_path)
            except Exception as e:
                logger.warning(f"Failed to delete {file_path}: {e}")
        
        # Очистка uploads (опционально)
        clean_uploads = request.json.get('clean_uploads', False)
        if clean_uploads:
            for file_path in UPLOADS_DIR.glob('*'):
                try:
                    file_path.unlink()
                except Exception as e:
                    logger.warning(f"Failed to delete {file_path}: {e}")
        
        gc.collect()
        
        return jsonify({
            'success': True,
            'message': 'Cache cleared',
            'temp_cleaned': True,
            'uploads_cleaned': clean_uploads
        })
        
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

# ============================================================
# ОБРАБОТЧИКИ ОШИБОК
# ============================================================
@app.errorhandler(404)
def not_found(error):
    return jsonify({'error': 'Not found', 'status': 404}), 404

@app.errorhandler(413)
def too_large(error):
    return jsonify({'error': 'File too large', 'status': 413}), 413

@app.errorhandler(500)
def internal_error(error):
    logger.error(f"Internal error: {error}")
    return jsonify({'error': 'Internal server error', 'status': 500}), 500

@app.errorhandler(Exception)
def handle_exception(e):
    logger.error(f"Unhandled exception: {traceback.format_exc()}")
    return jsonify({'error': str(e), 'status': 500}), 500

# ============================================================
# ЗАПУСК СЕРВЕРА
# ============================================================
def signal_handler(sig, frame):
    """Обработчик сигналов"""
    logger.info("Shutting down server...")
    save_gen_params(gen_params, USER_DATA_DIR)
    state.clear()
    stream_manager.stop_all()
    logger.info("Server shutdown complete")
    sys.exit(0)

signal.signal(signal.SIGINT, signal_handler)
signal.signal(signal.SIGTERM, signal_handler)

if __name__ == '__main__':
    local_ip = get_local_ip()
    
    print("=" * 70)
    print("  MD LLM Server v5.5.0 - Refactored")
    print("=" * 70)
    print(f"\n📁 Directories:")
    print(f"   App: {APP_DIR}")
    print(f"   Models: {MODELS_DIR}")
    print(f"   User data: {USER_DATA_DIR}")
    
    # Список моделей
    models = find_models(MODELS_DIR)
    mmprojs = find_mmproj_files(MODELS_DIR)
    
    print(f"\n📦 Models found: {len(models)}")
    for m in models[:5]:
        print(f"   • {m['name']} ({m['size_gb']} GB)")
    if len(models) > 5:
        print(f"   ... and {len(models) - 5} more")
    
    if mmprojs:
        print(f"\n🎨 Vision files: {len(mmprojs)}")
        for m in mmprojs[:3]:
            print(f"   • {m['name']} ({m['size_mb']} MB)")
    
    # Системная информация
    ram = get_ram_stats()
    if ram['total_mb'] > 0:
        print(f"\n💾 RAM: {ram['used_mb']}/{ram['total_mb']} MB ({ram['percent']}%)")
    
    gpus = get_gpu_stats()
    if gpus:
        print(f"\n🎮 GPUs: {len(gpus)}")
        for gpu in gpus:
            print(f"   • {gpu['name']}: {gpu['mem_used_mb']}/{gpu['mem_total_mb']} MB, util {gpu['util_percent']}%")
    
    print(f"\n🔧 Components:")
    print(f"   llama_cpp: {'✅' if LLAMA_AVAILABLE else '❌'}")
    print(f"   mtmd_cpp: {'✅' if MTMD_AVAILABLE else '❌'}")
    print(f"   psutil: {'✅' if PSUTIL_AVAILABLE else '❌'}")
    
    print(f"\n🌐 Server URLs:")
    print(f"   http://localhost:{config.server.port}")
    print(f"   http://{local_ip}:{config.server.port}")
    print(f"   http://0.0.0.0:{config.server.port}")
    
    print("\n⚙️ Controls:")
    print("   Press Ctrl+C to stop the server")
    print("=" * 70)
    
    try:
        app.run(
            host=config.server.host,
            port=config.server.port,
            debug=config.server.debug,
            threaded=True,
            use_reloader=False
        )
    except OSError as e:
        if "Address already in use" in str(e):
            print(f"\n❌ Port {config.server.port} is already in use!")
        else:
            print(f"\n❌ Failed to start server: {e}")
        sys.exit(1)
    except Exception as e:
        print(f"\n❌ Unexpected error: {e}")
        traceback.print_exc()
        sys.exit(1)