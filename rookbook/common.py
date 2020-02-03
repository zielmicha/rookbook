import os, threading, binascii

def _run_asyncio_ipython(loop, local_ns):
    import IPython, concurrent.futures
    original_run_cell = IPython.InteractiveShell.run_cell

    def run_cell_thread(self, *args, **kwargs):
        self.autoawait = False

        f = concurrent.futures.Future()
        def run():
            f.set_result(original_run_cell(self, *args, **kwargs))

        loop.call_soon_threadsafe(run)
        return f.result()

    IPython.InteractiveShell.run_cell = run_cell_thread

    from IPython import embed
    from traitlets.config import get_config
    _c = get_config()
    _c.InteractiveShellEmbed.colors = "Linux"
    IPython.terminal.embed.InteractiveShellEmbed(config=_c).mainloop(local_ns=local_ns)

    os._exit(0)

def start_asyncio_ipython(local_ns):
    import asyncio
    loop = asyncio.get_event_loop()
    threading.Thread(target=_run_asyncio_ipython, args=[loop, local_ns]).start()

def write_file(path, data):
    tmp_path = path + '.' + binascii.hexlify(os.urandom(6)).decode()
    if isinstance(data, str): data = data.encode('utf8')
    with open(tmp_path, 'wb') as f:
        f.write(data)
    os.rename(tmp_path, path)
