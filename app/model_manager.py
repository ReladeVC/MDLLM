#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Модуль управления моделью LLM"""

import time
import gc
import threading
import logging
from pathlib import Path
from typing import Optional, Any, Dict, List
from dataclasses import dataclass, field
from contextlib import contextmanager
from contextlib import redirect_stdout, redirect_stderr
import os

logger = logging.getLogger('MD_LLM.Model')

# ============================================================
# СОСТОЯНИЕ МОДЕЛИ
# ============================================================

@dataclass
class ModelState:
    """Потокобезопасное состояние модели"""
    llm: Optional[Any] = None
    current_model: Optional[str] = None
    current_model_path: Optional[Path] = None
    gpu_enabled: bool = False
    gpu_layers: int = 0
    n_ctx: int = 8192
    n_batch: int = 4096
    chat_handler: Optional[Any] = None
    current_mmproj: Optional[str] = None
    handler_type: Optional[str] = None
    mtmd_ctx: Optional[Any] = None
    load_time: Optional[float] = None
    last_used: float = field(default_factory=time.time)

    _lock: threading.RLock = field(default_factory=threading.RLock)

    def get_llm(self):
        """Получить экземпляр модели"""
        with self._lock:
            self.last_used = time.time()
            return self.llm

    def update(self, **kwargs):
        """Обновить состояние"""
        with self._lock:
            for key, value in kwargs.items():
                if hasattr(self, key):
                    setattr(self, key, value)
            self.last_used = time.time()

    def clear(self):
        """Очистить состояние и освободить память"""
        with self._lock:
            self._cleanup_resources()
            self.llm = None
            self.current_model = None
            self.current_model_path = None
            self.gpu_enabled = False
            self.gpu_layers = 0
            self.chat_handler = None
            self.current_mmproj = None
            self.handler_type = None
            self.load_time = None
            # Вызываем gc.collect() только при полной выгрузке
            gc.collect()

    def _cleanup_resources(self):
        """Освобождение ресурсов vision"""
        if self.mtmd_ctx:
            try:
                from vision_handler import mtmd_cpp
                if mtmd_cpp:
                    mtmd_cpp.mtmd_free(self.mtmd_ctx)
            except Exception:
                pass
            self.mtmd_ctx = None

    @property
    def is_loaded(self) -> bool:
        """Проверка, загружена ли модель"""
        return self.llm is not None

    @property
    def vision_active(self) -> bool:
        """Проверка, активен ли vision"""
        return self.chat_handler is not None


# ============================================================
# ПОТОКОБЕЗОПАСНЫЙ ДОСТУП К МОДЕЛИ
# ============================================================

class ThreadSafeModel:
    """Потокобезопасный доступ к модели с очередью запросов"""
    def __init__(self, timeout: int = 300):
        self.timeout = timeout
        self._lock = threading.RLock()
        self._request_count = 0
        self._active_requests = 0
        self._lock_stats = threading.Lock()

    @contextmanager
    def acquire(self, timeout: Optional[int] = None):
        """Получить эксклюзивный доступ к модели"""
        timeout_val = timeout or self.timeout

        with self._lock_stats:
            self._request_count += 1
            self._active_requests += 1

        try:
            if not self._lock.acquire(timeout=timeout_val):
                raise TimeoutError(f"Модель занята, таймаут {timeout_val}с")
            try:
                yield
            finally:
                self._lock.release()
        finally:
            with self._lock_stats:
                self._active_requests -= 1

    @property
    def stats(self) -> Dict[str, int]:
        """Статистика использования"""
        with self._lock_stats:
            return {
                'total_requests': self._request_count,
                'active_requests': self._active_requests
            }


# ============================================================
# МЕНЕДЖЕР МОДЕЛИ
# ============================================================

class ModelManager:
    """Централизованное управление моделью LLM"""
    def __init__(self, state: ModelState, lock: ThreadSafeModel):
        self.state = state
        self.lock = lock
        self._model_cache: Dict[str, Any] = {}

    def load_model(self, model_path: Path, **kwargs) -> Dict[str, Any]:
        """Загрузка модели"""
        from config import load_gen_params, save_gen_params, USER_DATA_DIR

        model_name = model_path.name
        logger.info(f"Загрузка модели: {model_name}")

        # Очистка перед загрузкой
        self.state.clear()

        # Параметры по умолчанию
        gen_params = load_gen_params(USER_DATA_DIR)
        n_ctx = int(kwargs.get('n_ctx', gen_params.get('n_ctx', 8192)))
        n_batch = int(kwargs.get('n_batch', gen_params.get('n_batch', 4096)))
        n_threads = int(kwargs.get('n_threads', gen_params.get('n_threads', 4)))
        n_threads_batch = int(kwargs.get('n_threads_batch', gen_params.get('n_threads_batch', 4)))
        n_gpu_layers = int(kwargs.get('n_gpu_layers', gen_params.get('n_gpu_layers', -1)))
        use_gpu = kwargs.get('use_gpu', True)
        flash_attn = bool(kwargs.get('flash_attn', gen_params.get('flash_attn', True)))

        llama_kwargs = {
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

        logger.info(f"  Контекст: {n_ctx}, Batch: {n_batch}")
        if use_gpu:
            logger.info(f"  GPU слои: {n_gpu_layers}")

        start_time = time.time()

        try:
            from llama_cpp import Llama as LlamaClass
        except ImportError:
            raise RuntimeError("llama_cpp не установлен. Установите: pip install llama-cpp-python")

        # Подавляем вывод от llama.cpp
        with open(os.devnull, 'w') as devnull:
            with redirect_stdout(devnull), redirect_stderr(devnull):
                llm = LlamaClass(**llama_kwargs)

        elapsed = round(time.time() - start_time, 2)

        self.state.update(
            llm=llm,
            current_model=model_name,
            current_model_path=model_path,
            gpu_enabled=use_gpu,
            gpu_layers=n_gpu_layers if use_gpu else 0,
            n_ctx=n_ctx,
            n_batch=n_batch,
            load_time=elapsed
        )

        logger.info(f"Модель загружена за {elapsed}с")

        # Регистрация vision handler если есть mmproj
        if self.state.current_mmproj:
            self._setup_vision_handler(model_name)

        return {
            'success': True,
            'model': model_name,
            'gpu_enabled': use_gpu,
            'n_gpu_layers': n_gpu_layers if use_gpu else 0,
            'n_ctx': n_ctx,
            'n_batch': n_batch,
            'flash_attn': flash_attn and use_gpu,
            'load_time': elapsed,
            'vision_active': self.state.vision_active,
            'handler_type': self.state.handler_type
        }

    def unload_model(self) -> Dict[str, Any]:
        """Выгрузка модели"""
        if self.state.llm:
            model_name = self.state.current_model
            logger.info(f"Выгрузка модели: {model_name}")
            self.state.clear()
            return {'success': True, 'message': 'Модель выгружена'}
        return {'success': True, 'message': 'Модель не была загружена'}

    def toggle_gpu(self, use_gpu: bool) -> Dict[str, Any]:
        """Переключение GPU/CPU с перезагрузкой модели"""
        if not self.state.llm or not self.state.current_model:
            self.state.gpu_enabled = use_gpu
            return {'success': True, 'gpu_enabled': use_gpu, 'message': 'Модель не загружена, настройка сохранена'}

        model_name = self.state.current_model
        n_ctx = self.state.n_ctx
        n_batch = self.state.n_batch

        logger.info(f"GPU toggle: перезагрузка '{model_name}' с gpu={use_gpu}")

        try:
            return self.load_model(
                self.state.current_model_path,
                use_gpu=use_gpu,
                n_ctx=n_ctx,
                n_batch=n_batch
            )
        except MemoryError:
            self.state.clear()
            gc.collect()
            return {'error': 'Недостаточно памяти', 'gpu_enabled': not use_gpu}
        except Exception as e:
            logger.error(f"Ошибка перезагрузки: {e}")
            return {'error': str(e), 'gpu_enabled': self.state.gpu_enabled}

    def _setup_vision_handler(self, model_name: str):
        """Настройка vision handler"""
        try:
            from vision_handler import register_vision_handler
            mmproj_path = self.state.current_model_path.parent / self.state.current_mmproj
            if mmproj_path.exists():
                with open(os.devnull, 'w') as devnull:
                    with redirect_stdout(devnull), redirect_stderr(devnull):
                        handler, htype = register_vision_handler(
                            self.state.llm, mmproj_path, model_name
                        )
                self.state.update(chat_handler=handler, handler_type=htype)
                if not handler:
                    self.state.update(current_mmproj=None)
        except Exception as e:
            logger.warning(f"Ошибка настройки vision: {e}")

    def get_info(self) -> Dict[str, Any]:
        """Информация о загруженной модели"""
        if not self.state.llm:
            return {'error': 'Модель не загружена'}

        llm = self.state.get_llm()
        return {
            'success': True,
            'info': {
                'name': self.state.current_model,
                'gpu_enabled': self.state.gpu_enabled,
                'gpu_layers': self.state.gpu_layers,
                'n_ctx': self.state.n_ctx,
                'n_batch': self.state.n_batch,
                'vocab_size': getattr(llm, 'n_vocab', None),
                'load_time': self.state.load_time,
                'last_used': self.state.last_used
            }
        }


# ============================================================
# ПОИСК МОДЕЛЕЙ
# ============================================================

def find_models(models_dir: Path) -> List[Dict[str, Any]]:
    """Поиск GGUF моделей"""
    if not models_dir.exists():
        return []

    models = []
    exclude_patterns = ['mmproj', 'vision', 'clip', 'vlm']

    for f in sorted(models_dir.glob('*.gguf')):
        name_lower = f.name.lower()
        if not any(p in name_lower for p in exclude_patterns):
            try:
                stat = f.stat()
                models.append({
                    'name': f.name,
                    'size_gb': round(stat.st_size / (1024**3), 2),
                    'size_mb': round(stat.st_size / (1024**2), 1),
                    'modified': stat.st_mtime
                })
            except Exception:
                continue

    return models


def find_mmproj_files(models_dir: Path) -> List[Dict[str, Any]]:
    """Поиск mmproj/vision файлов"""
    if not models_dir.exists():
        return []

    files = []
    seen = set()
    patterns = ['*mmproj*.gguf', '*vision*.gguf', '*clip*.gguf']

    for pattern in patterns:
        for f in models_dir.glob(pattern):
            if f.name not in seen:
                seen.add(f.name)
                try:
                    stat = f.stat()
                    files.append({
                        'name': f.name,
                        'size_mb': round(stat.st_size / (1024**2), 1),
                        'size_gb': round(stat.st_size / (1024**3), 2)
                    })
                except Exception:
                    continue

    return files


def get_model_requirements(model_path: Path, n_ctx: int) -> Dict[str, Any]:
    """Расчет требований к памяти"""
    try:
        file_size = model_path.stat().st_size
        context_memory = n_ctx * 2 * 1024  # ~2KB per token
        return {
            'model_size_gb': round(file_size / (1024**3), 2),
            'context_memory_mb': round(context_memory / (1024**2), 1),
            'estimated_ram_gb': round((file_size + context_memory) / (1024**3), 1)
        }
    except Exception:
        return {}
