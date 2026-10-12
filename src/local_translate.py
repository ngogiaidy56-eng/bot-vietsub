#!/usr/bin/env python3
"""Offline translation helper using Argos Translate models, downloaded when first needed."""
import fcntl
import json
import os
import sys
import time


def installed_translation(argos_translate, source, target):
    try:
        return argos_translate.get_translation_from_codes(source, target)
    except (LookupError, Exception):
        return None


def ensure_pair(argos_package, argos_translate, source, target):
    translation = installed_translation(argos_translate, source, target)
    if translation:
        return translation

    # Serialize model installation across concurrently processed videos in this Linux service.
    lock_dir = os.environ.get("ARGOS_LOCK_DIR", "/tmp")
    lock_path = os.path.join(lock_dir, "hendy-argos-install.lock")
    with open(lock_path, "w", encoding="utf-8") as lock_file:
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
        translation = installed_translation(argos_translate, source, target)
        if translation:
            return translation
        packages = argos_package.get_available_packages()
        candidate = next((p for p in packages if p.from_code == source and p.to_code == target), None)
        if candidate is None:
            return None
        package_path = candidate.download()
        argos_package.install_from_path(package_path)
        # Give the runtime a fresh lookup after install.
        time.sleep(0.2)
        return installed_translation(argos_translate, source, target)


def main():
    if len(sys.argv) != 4:
        raise RuntimeError("Usage: local_translate.py SOURCE_CODE INPUT_JSON OUTPUT_JSON")
    source = sys.argv[1].strip().lower()
    input_path, output_path = sys.argv[2], sys.argv[3]
    with open(input_path, "r", encoding="utf-8") as f:
        texts = json.load(f)
    if not isinstance(texts, list):
        raise RuntimeError("Translation input must be a JSON list of strings")
    if source == "vi":
        translated = [str(text) for text in texts]
    else:
        try:
            import argostranslate.package as argos_package
            import argostranslate.translate as argos_translate
        except ImportError as exc:
            raise RuntimeError("Argos Translate is missing. Install python package argostranslate in the runtime image.") from exc

        # Prefer a direct model; if not published, use source->English->Vietnamese.
        direct = ensure_pair(argos_package, argos_translate, source, "vi")
        if direct:
            translated = [direct.translate(str(text)) for text in texts]
        else:
            if source == "en":
                source_to_english = None
            else:
                source_to_english = ensure_pair(argos_package, argos_translate, source, "en")
            english_to_vietnamese = ensure_pair(argos_package, argos_translate, "en", "vi")
            if english_to_vietnamese is None:
                raise RuntimeError("Không tải được mô hình dịch English -> Vietnamese từ Argos Translate.")
            if source != "en" and source_to_english is None:
                raise RuntimeError(f"Argos Translate chưa có mô hình {source} -> Vietnamese hoặc {source} -> English. Hãy chọn SRT nguyên ngữ hoặc cài thêm gói ngôn ngữ cho mã '{source}'.")
            translated = []
            for text in texts:
                value = str(text)
                if source_to_english:
                    value = source_to_english.translate(value)
                translated.append(english_to_vietnamese.translate(value))

    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(translated, f, ensure_ascii=False)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
