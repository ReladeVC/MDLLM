#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Централизованная конфигурация MD LLM Server"""

import os
import json
import secrets
import logging
from pathlib import Path
from dataclasses import dataclass, field
from typing import Dict, Any, Optional

logger = logging.getLogger('MD_LLM.Config')

# ============================================================
# БАЗОВЫЕ ПУТИ
# ============================================================
APP_DIR = Path(__file__).parent.resolve()
BASE_DIR = APP_DIR.parent
PYTHON_DIR = BASE_DIR / 'python'
LIB_DIR = PYTHON_DIR / 'Lib' / 'site-packages' / 'llama_cpp' / 'lib'
CUDA_DIR = LIB_DIR

# Директории данных
MODELS_DIR = BASE_DIR / 'models'
USER_DATA_DIR = BASE_DIR / 'user-data'
UPLOADS_DIR = USER_DATA_DIR / 'uploads'
CACHE_DIR = BASE_DIR / '.cache'
TEMP_DIR = BASE_DIR / 'temp'

# Создание директорий
for d in [MODELS_DIR, USER_DATA_DIR, UPLOADS_DIR, CACHE_DIR, TEMP_DIR]:
    d.mkdir(parents=True, exist_ok=True)

# ============================================================
# ПАРАМЕТРЫ ГЕНЕРАЦИИ ПО УМОЛЧАНИЮ
# ============================================================
DEFAULT_GEN_PARAMS = {
    'temperature': 0.7,
    'top_p': 0.95,
    'max_tokens': 2048,
    'n_ctx': 8192,
    'repeat_penalty': 1.1,
    'top_k': 40,
    'frequency_penalty': 0.0,
    'presence_penalty': 0.0,
    'n_batch': 4096,
    'n_threads': 4,
    'n_threads_batch': 4,
    'n_gpu_layers': -1,
    'flash_attn': True,
    'min_p': 0.05
}


@dataclass
class ServerConfig:
    """Конфигурация сервера"""
    host: str = '0.0.0.0'
    port: int = 3595
    debug: bool = False


@dataclass
class LimitsConfig:
    """Лимиты приложения"""
    max_upload_size_mb: int = 100
    max_image_size_mb: int = 50
    max_history_messages: int = 50
    request_timeout: int = 300
    stream_timeout: int = 600

    @property
    def max_upload_size_bytes(self) -> int:
        return self.max_upload_size_mb * 1024 * 1024

    @property
    def max_image_size_bytes(self) -> int:
        return self.max_image_size_mb * 1024 * 1024


@dataclass
class AppConfig:
    """Основная конфигурация приложения"""
    server: ServerConfig = field(default_factory=ServerConfig)
    limits: LimitsConfig = field(default_factory=LimitsConfig)
    secret_key: str = field(default_factory=lambda: secrets.token_hex(32))

    def load_from_file(self) -> bool:
        """Загрузка конфигурации из config.json"""
        config_path = APP_DIR / 'config.json'
        if not config_path.exists():
            return False

        try:
            with open(config_path, 'r', encoding='utf-8') as f:
                data = json.load(f)

            if not isinstance(data, dict):
                return False

            # Загрузка настроек сервера
            srv = data.get('server', {})
            if srv:
                self.server.host = srv.get('host', self.server.host)
                self.server.port = int(srv.get('port', self.server.port))
                self.server.debug = bool(srv.get('debug', self.server.debug))

            # Загрузка лимитов
            lim = data.get('limits', {})
            if lim:
                self.limits.max_upload_size_mb = int(lim.get('max_upload_size_mb', self.limits.max_upload_size_mb))
                self.limits.max_image_size_mb = int(lim.get('max_image_size_mb', self.limits.max_image_size_mb))
                self.limits.max_history_messages = int(lim.get('max_history_messages', self.limits.max_history_messages))
                self.limits.request_timeout = int(lim.get('request_timeout', self.limits.request_timeout))
                self.limits.stream_timeout = int(lim.get('stream_timeout', self.limits.stream_timeout))

            logger.info(f"Конфигурация загружена из {config_path}")
            return True

        except Exception as e:
            logger.warning(f"Ошибка загрузки конфигурации: {e}")
            return False

    def save_to_file(self) -> bool:
        """Сохранение конфигурации в config.json"""
        config_path = APP_DIR / 'config.json'
        try:
            data = {
                'server': {
                    'host': self.server.host,
                    'port': self.server.port,
                    'debug': self.server.debug
                },
                'limits': {
                    'max_upload_size_mb': self.limits.max_upload_size_mb,
                    'max_image_size_mb': self.limits.max_image_size_mb,
                    'max_history_messages': self.limits.max_history_messages,
                    'request_timeout': self.limits.request_timeout,
                    'stream_timeout': self.limits.stream_timeout
                }
            }
            with open(config_path, 'w', encoding='utf-8') as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
            return True
        except Exception as e:
            logger.error(f"Ошибка сохранения конфигурации: {e}")
            return False


def load_gen_params(user_data_dir: Path) -> Dict[str, Any]:
    """Загрузка параметров генерации из файла"""
    params_file = user_data_dir / 'modelGenParams.json'
    params = DEFAULT_GEN_PARAMS.copy()

    if params_file.exists():
        try:
            with open(params_file, 'r', encoding='utf-8') as f:
                loaded = json.load(f)
                if isinstance(loaded, dict) and 'data' in loaded and isinstance(loaded['data'], dict):
                    params.update(loaded['data'])
                elif isinstance(loaded, dict):
                    params.update(loaded)

            # Удаляем лишние ключи
            for k in list(params.keys()):
                if k not in DEFAULT_GEN_PARAMS:
                    del params[k]

            logger.info("Параметры генерации загружены")
        except Exception as e:
            logger.warning(f"Ошибка загрузки параметров: {e}")

    return params


def save_gen_params(params: Dict[str, Any], user_data_dir: Path) -> bool:
    """Сохранение параметров генерации в файл"""
    try:
        params_file = user_data_dir / 'modelGenParams.json'
        with open(params_file, 'w', encoding='utf-8') as f:
            json.dump(params, f, ensure_ascii=False, indent=2)
        return True
    except Exception as e:
        logger.error(f"Ошибка сохранения параметров: {e}")
        return False


def setup_cuda_environment():
    """Настройка CUDA путей для portable сборки"""
    if not CUDA_DIR.exists():
        return

    os.environ["CUDA_PATH"] = str(CUDA_DIR)
    os.environ["CUDA_HOME"] = str(CUDA_DIR)
    os.environ["CUDA_PATH_V12_0"] = str(CUDA_DIR)
    os.environ["PATH"] = str(CUDA_DIR) + os.pathsep + os.environ.get('PATH', '')

    paths_to_add = [
        str(LIB_DIR),
        str(CUDA_DIR),
        str(PYTHON_DIR / 'Lib' / 'site-packages'),
        str(PYTHON_DIR / 'Scripts'),
        str(PYTHON_DIR),
        str(BASE_DIR / 'bin'),
    ]

    for p in paths_to_add:
        if os.path.isdir(p):
            os.environ['PATH'] = p + os.pathsep + os.environ.get('PATH', '')
            if hasattr(os, 'add_dll_directory'):
                try:
                    os.add_dll_directory(p)
                except Exception:
                    pass
