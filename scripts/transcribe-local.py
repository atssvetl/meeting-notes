"""CPU-only recognition. Reads local PCM WAV; makes no network requests."""
import argparse
import json
from pathlib import Path
import sys
import wave

import numpy as np
import sherpa_onnx


def segments(samples, rate):
    """Limit attention memory; choose a quiet boundary between 15 and 25 seconds."""
    start = 0
    while start < len(samples):
        stop = min(start + 25 * rate, len(samples))
        if stop < len(samples):
            candidates = range(start + 15 * rate, stop, rate // 10)
            stop = min(candidates, key=lambda pos: float(np.mean(samples[pos:pos + rate // 10] ** 2)))
        yield start, samples[start:stop]
        start = stop


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--threads", type=int, default=2)
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--diarization-dir", required=True)
    parser.add_argument("--output-dir", help="Write speaker WAVs for online ASR instead of recognizing locally")
    parser.add_argument("files", nargs="*")
    args = parser.parse_args()
    model = Path(args.model_dir)
    diarization = Path(args.diarization_dir)
    for name in ["segmentation.onnx", "wespeaker_en_voxceleb_resnet34.onnx"]:
        if not (diarization / name).is_file():
            raise FileNotFoundError(name)
    if not args.output_dir:
        for name in ["encoder.int8.onnx", "decoder.onnx", "joiner.onnx", "tokens.txt"]:
            if not (model / name).is_file():
                raise FileNotFoundError(name)
    if args.check:
        print(json.dumps({"available": True, "version": sherpa_onnx.__version__}))
        return
    if not 1 <= args.threads <= 16 or not args.files:
        raise ValueError("Invalid runtime arguments")
    recognizer = None if args.output_dir else sherpa_onnx.OfflineRecognizer.from_transducer(
        encoder=str(model / "encoder.int8.onnx"), decoder=str(model / "decoder.onnx"),
        joiner=str(model / "joiner.onnx"), tokens=str(model / "tokens.txt"),
        model_type="nemo_transducer", num_threads=args.threads, sample_rate=16000,
        feature_dim=64, decoding_method="greedy_search", provider="cpu", debug=False,
    )
    audio = []
    for path in args.files:
        with wave.open(path, "rb") as source:
            if source.getnchannels() != 1 or source.getsampwidth() != 2 or source.getframerate() != 16000:
                raise ValueError("Expected mono PCM16, 16000 Hz")
            samples = np.frombuffer(source.readframes(source.getnframes()), dtype="<i2").astype(np.float32) / 32768
        audio.append(samples)
    # Cluster the entire recording, including silent chunks, to preserve time and speaker IDs.
    samples = np.concatenate(audio)
    seconds = len(samples) / 16000
    config = sherpa_onnx.OfflineSpeakerDiarizationConfig(
        segmentation=sherpa_onnx.OfflineSpeakerSegmentationModelConfig(
            pyannote=sherpa_onnx.OfflineSpeakerSegmentationPyannoteModelConfig(model=str(diarization / "segmentation.onnx")),
            num_threads=args.threads, provider="cpu"),
        embedding=sherpa_onnx.SpeakerEmbeddingExtractorConfig(
            model=str(diarization / "wespeaker_en_voxceleb_resnet34.onnx"), num_threads=args.threads, provider="cpu"),
        clustering=sherpa_onnx.FastClusteringConfig(num_clusters=-1, threshold=0.5),
        min_duration_on=0.3, min_duration_off=0.5,
    )
    if not config.validate():
        raise ValueError("Invalid diarization configuration")
    turns = sherpa_onnx.OfflineSpeakerDiarization(config).process(samples).sort_by_start_time()
    speakers, output = {}, []
    if args.output_dir:
        Path(args.output_dir).mkdir(parents=True, exist_ok=True)
    for turn in turns:
        speaker = speakers.setdefault(turn.speaker, len(speakers) + 1)
        first, last = max(0, round(turn.start * 16000)), min(len(samples), round(turn.end * 16000))
        for offset, segment in segments(samples[first:last], 16000):
            entry = {"start": round((first + offset) / 16000, 3), "end": round((first + offset + len(segment)) / 16000, 3), "speaker": speaker}
            if args.output_dir:
                name = f"turn-{len(output):05d}.wav"
                with wave.open(str(Path(args.output_dir) / name), "wb") as dest:
                    dest.setnchannels(1); dest.setsampwidth(2); dest.setframerate(16000)
                    dest.writeframes((segment * 32768).clip(-32768, 32767).astype("<i2").tobytes())
                entry["file"] = name
                output.append(entry)
                continue
            if len(segment) < 1600:
                segment = np.pad(segment, (0, 1600 - len(segment)))
            stream = recognizer.create_stream()
            stream.accept_waveform(16000, np.concatenate((segment, np.zeros(8000, dtype=np.float32))))
            recognizer.decode_stream(stream)
            text = stream.result.text.strip()
            if text:
                entry["text"] = text
                output.append(entry)
    output.sort(key=lambda e: e["start"])
    print(json.dumps({"text": " ".join(e.get("text", "") for e in output).strip(), "segments": output, "audioSeconds": seconds}, ensure_ascii=False))


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    try:
        main()
    except Exception as error:
        # Only error type is exposed; avoid logging audio/transcript or private paths.
        print(json.dumps({"error": type(error).__name__}), file=sys.stderr)
        sys.exit(1)
