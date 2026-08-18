#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Модуль управления стримингом"""

import threading
import time
import logging
import json
import uuid
from typing import Optional, Any, Dict, Generator

logger = logging.getLogger('MD_LLM.Stream')


class StreamManager:
    """Потокобезопасное управление активными стримами"""
    def __init__(self, timeout: int = 600):
        self._streams: Dict[str, Dict[str, Any]] = {}
        self._lock = threading.RLock()
        self._timeout = timeout

    def create_stream(self, stream_id: Optional[str] = None) -> str:
        """Создать новый стрим"""
        if stream_id is None:
            stream_id = str(uuid.uuid4())
        with self._lock:
            self._streams[stream_id] = {
                'active': True,
                'start': time.time(),
                'tokens': 0,
                'created': time.time()
            }
        logger.debug(f"Создан стрим: {stream_id}")
        return stream_id

    def is_active(self, stream_id: str) -> bool:
        """Проверка активности стрима"""
        with self._lock:
            stream = self._streams.get(stream_id)
            return stream.get('active', False) if stream else False

    def update_tokens(self, stream_id: str, count: int):
        """Обновить количество токенов"""
        with self._lock:
            if stream_id in self._streams:
                self._streams[stream_id]['tokens'] = count

    def get_tokens(self, stream_id: str) -> int:
        """Получить количество токенов"""
        with self._lock:
            stream = self._streams.get(stream_id)
            return stream.get('tokens', 0) if stream else 0

    def stop_stream(self, stream_id: str) -> bool:
        """Остановить стрим"""
        with self._lock:
            if stream_id in self._streams:
                self._streams[stream_id]['active'] = False
                logger.info(f"Стрим остановлен: {stream_id}")
                return True
            return False

    def stop_all(self):
        """Остановить все стримы"""
        with self._lock:
            for stream_id in self._streams:
                self._streams[stream_id]['active'] = False
            logger.info(f"Остановлены все стримы ({len(self._streams)})")

    def remove_stream(self, stream_id: str):
        """Удалить стрим"""
        with self._lock:
            self._streams.pop(stream_id, None)

    def cleanup_expired(self):
        """Очистка истёкших стримов"""
        now = time.time()
        with self._lock:
            expired = [
                sid for sid, data in self._streams.items()
                if now - data.get('created', 0) > self._timeout
            ]
            for sid in expired:
                del self._streams[sid]
            if expired:
                logger.info(f"Очищено {len(expired)} истёкших стримов")

    def get_all_active(self) -> list:
        """Получить список активных стримов"""
        with self._lock:
            now = time.time()
            return [
                {
                    'id': sid,
                    'elapsed': round(now - data['start'], 1),
                    'tokens': data.get('tokens', 0)
                }
                for sid, data in self._streams.items()
                if data.get('active', False)
            ]

    @property
    def active_count(self) -> int:
        """Количество активных стримов"""
        with self._lock:
            return sum(1 for data in self._streams.values() if data.get('active', False))


# ============================================================
# SSE ГЕНЕРАТОР
# ============================================================

def create_sse_response(generator: Generator, stream_id: str, stream_manager: StreamManager):
    """Создание SSE ответа с автоматической очисткой"""
    try:
        yield from generator
    finally:
        stream_manager.remove_stream(stream_id)
        logger.debug(f"Стрим завершён: {stream_id}")


def format_sse_event(data: Any) -> str:
    """Форматирование SSE события"""
    return f"data: {json.dumps(data)}\n\n"


def format_sse_done() -> str:
    """Событие завершения SSE"""
    return "data: [DONE]\n\n"


def format_sse_error(error: str) -> str:
    """Событие ошибки SSE"""
    return format_sse_event({'error': error})
