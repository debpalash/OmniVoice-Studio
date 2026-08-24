from __future__ import annotations


def test_url_join_does_not_duplicate_slashes():
    from speech_client.__main__ import _join_url

    assert _join_url("http://127.0.0.1:3902/", "/v1/status") == (
        "http://127.0.0.1:3902/v1/status"
    )


def test_multipart_matches_openai_audio_contract():
    from speech_client.__main__ import _encode_multipart

    body, content_type = _encode_multipart(
        filename='sample.wav',
        audio=b"RIFF-audio",
        fields={"model": "whisper-1", "response_format": "text"},
        boundary="fixed-boundary",
    )

    assert content_type == "multipart/form-data; boundary=fixed-boundary"
    assert b'name="model"\r\n\r\nwhisper-1' in body
    assert b'name="response_format"\r\n\r\ntext' in body
    assert b'name="file"; filename="sample.wav"' in body
    assert b"Content-Type: audio/wav" in body
    assert b"RIFF-audio" in body
    assert body.endswith(b"--fixed-boundary--\r\n")


def test_json_transcription_response_extracts_insertable_text():
    from speech_client.__main__ import _response_text

    assert _response_text(b'{"text":"hello"}', "application/json") == "hello"
    assert _response_text(b"hello", "text/plain") == "hello"
