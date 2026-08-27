import asyncio


def test_cancel_before_task_publication_revokes_the_next_generation():
    from api.routers.setup import download

    repo_id = download.KNOWN_MODELS[0]["repo_id"]
    download._cancelled.discard(repo_id)
    try:
        asyncio.run(download.cancel_install_and_wait(repo_id))
        assert repo_id in download._cancelled
    finally:
        download._cancelled.discard(repo_id)


def test_duplicate_model_install_reuses_the_running_worker():
    from api.routers.setup import download

    repo_id = download.KNOWN_MODELS[0]["repo_id"]
    download._install_cooldowns.pop(repo_id, None)
    with download._active_installs_lock:
        download._active_installs.add(repo_id)
    try:
        result = asyncio.run(download.install_model(download.InstallModelRequest(repo_id=repo_id)))
    finally:
        with download._active_installs_lock:
            download._active_installs.discard(repo_id)

    assert result == {"status": "already_running", "repo_id": repo_id}
