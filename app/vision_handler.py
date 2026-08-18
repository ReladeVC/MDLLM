#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Модуль обработки vision (мультимодальность)"""

import ctypes
import logging
import base64
import json
import time
import os
from pathlib import Path
from typing import Optional, Any, List, Dict, Tuple
from contextlib import redirect_stdout, redirect_stderr

logger = logging.getLogger('MD_LLM.Vision')

# ============================================================
# ПРОВЕРКА ДОСТУПНОСТИ
# ============================================================

MTMD_AVAILABLE = False
mtmd_cpp = None

try:
    import llama_cpp.mtmd_cpp as mtmd_cpp
    MTMD_AVAILABLE = True
    logger.info("mtmd_cpp импортирован успешно")
except ImportError:
    logger.warning("mtmd_cpp недоступен (vision отключен)")
except Exception as e:
    logger.warning(f"Ошибка импорта mtmd_cpp: {e}")


# ============================================================
# ОПРЕДЕЛЕНИЕ ТИПА HANDLER
# ============================================================

def detect_handler_type(model_name: Optional[str], mmproj_name: Optional[str]) -> str:
    """Определение типа vision handler по имени модели и mmproj"""
    combined = ((model_name or '') + ' ' + (mmproj_name or '')).lower()

    if any(k in combined for k in ['qwen3', 'qwen3.5', 'qwen3.6', 'qwopus']):
        return 'qwen3vl'
    if any(k in combined for k in ['qwen2', 'qwen2.5', 'qwen-vl']):
        return 'qwen2vl'
    if any(k in combined for k in ['llava', 'vicuna', 'llama-3', 'llama-2', 'bakllava']):
        return 'llava15'

    return 'qwen3vl'


# ============================================================
# СОЗДАНИЕ HANDLER
# ============================================================

def create_vision_handler(mmproj_path: Path, handler_type: str) -> Tuple[Optional[Any], Optional[str]]:
    """Создание vision handler с fallback"""
    errors = []

    # Qwen3VL
    if handler_type == 'qwen3vl':
        try:
            from llama_cpp.qwen3vl_handler import Qwen3VLChatHandler
            handler = Qwen3VLChatHandler(clip_model_path=str(mmproj_path), verbose=False)
            logger.info("Создан КАСТОМНЫЙ Qwen3VLChatHandler")
            return handler, 'custom_qwen3vl'
        except Exception as e:
            errors.append(f"Кастомный Qwen3VL: {e}")

        try:
            from llama_cpp.llama_chat_format import Qwen3VLChatHandler as LibHandler
            handler = LibHandler(clip_model_path=str(mmproj_path), verbose=False)
            logger.info("Создан библиотечный Qwen3VLChatHandler")
            return handler, 'qwen3vl'
        except Exception as e:
            errors.append(f"Библиотечный Qwen3VL: {e}")

    # Qwen2VL / Qwen3VL fallback
    if handler_type in ('qwen3vl', 'qwen2vl'):
        try:
            from llama_cpp.llama_chat_format import Qwen25VLChatHandler
            handler = Qwen25VLChatHandler(clip_model_path=str(mmproj_path), verbose=False)
            logger.info("Создан Qwen25VLChatHandler (fallback)")
            return handler, 'qwen25vl'
        except Exception as e:
            errors.append(f"Qwen25VL: {e}")

    # LLaVA fallback
    try:
        from llama_cpp.llama_chat_format import Llava15ChatHandler
        handler = Llava15ChatHandler(clip_model_path=str(mmproj_path), verbose=False)
        logger.info("Создан Llava15ChatHandler (fallback)")
        return handler, 'llava15'
    except Exception as e:
        errors.append(f"Llava15: {e}")

    logger.error("Не удалось создать vision handler:")
    for err in errors:
        logger.error(f"  {err}")

    return None, None


# ============================================================
# РЕГИСТРАЦИЯ HANDLER
# ============================================================

def register_vision_handler(
    llama_instance: Any,
    mmproj_path: Path,
    model_name: Optional[str] = None
) -> Tuple[Optional[Any], Optional[str]]:
    """Регистрация vision handler в модели"""
    mmproj_name = mmproj_path.name if hasattr(mmproj_path, 'name') else str(mmproj_path)
    handler_type = detect_handler_type(model_name, mmproj_name)

    logger.info(f"Определён тип handler: {handler_type}")

    handler, actual_type = create_vision_handler(mmproj_path, handler_type)

    if not handler:
        return None, None

    # Логирование MRO для отладки
    try:
        mro_names = [cls.__name__ for cls in type(handler).__mro__]
        logger.info(f"Handler MRO: {' -> '.join(mro_names)}")
    except Exception:
        pass

    llama_instance.chat_handler = handler
    logger.info(f"Vision handler зарегистрирован: {mmproj_name} (тип: {actual_type})")

    return handler, actual_type


# ============================================================
# СОЗДАНИЕ MTMD КОНТЕКСТА
# ============================================================

def create_mtmd_context(
    llama_instance: Any,
    mmproj_path: Path,
    use_gpu: bool = False,
    existing_ctx: Optional[Any] = None
) -> Any:
    """Создание mtmd контекста с освобождением предыдущего"""
    if not MTMD_AVAILABLE:
        raise RuntimeError("mtmd_cpp недоступен")

    # Освобождаем предыдущий контекст
    if existing_ctx is not None:
        try:
            mtmd_cpp.mtmd_free(existing_ctx)
        except Exception:
            pass

    params = mtmd_cpp.mtmd_context_params_default()
    params.n_threads = llama_instance.n_threads
    params.use_gpu = use_gpu
    params.image_min_tokens = 1024
    params.image_max_tokens = 4096

    model_ptr = llama_instance._model.model
    ctx = mtmd_cpp.mtmd_init_from_file(
        str(mmproj_path).encode("utf-8"), model_ptr, params
    )

    if not ctx:
        raise RuntimeError("Не удалось создать mtmd контекст")

    gpu_str = "GPU" if use_gpu else "CPU"
    logger.info(f"mtmd контекст создан ({gpu_str})")

    return ctx


# ============================================================
# ОБРАБОТКА ИЗОБРАЖЕНИЙ
# ============================================================

def decode_image(b64_data: str) -> Optional[bytes]:
    """Декодирование base64 изображения"""
    try:
        # Убираем префикс data:...
        if ',' in b64_data:
            b64_data = b64_data.split(',', 1)[1]
        return base64.b64decode(b64_data)
    except Exception as e:
        logger.error(f"Ошибка декодирования изображения: {e}")
        return None


def create_bitmap(image_bytes: bytes, ctx: Any) -> Optional[Any]:
    """Создание bitmap из байтов изображения"""
    try:
        buf_array = (ctypes.c_uint8 * len(image_bytes))(*image_bytes)
        bitmap = mtmd_cpp.mtmd_helper_bitmap_init_from_buf(ctx, buf_array, len(image_bytes))
        return bitmap
    except Exception as e:
        logger.error(f"Ошибка создания bitmap: {e}")
        return None


def free_bitmap(bitmap: Any):
    """Освобождение bitmap"""
    if bitmap:
        try:
            mtmd_cpp.mtmd_bitmap_free(bitmap)
        except Exception:
            pass


def free_chunks(chunks: Any):
    """Освобождение chunks"""
    if chunks:
        try:
            mtmd_cpp.mtmd_input_chunks_free(chunks)
        except Exception:
            pass
