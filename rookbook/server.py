import asyncio, http, os, io, glob, websockets, json
from . import book

def get_static(content_type, path):
    with open(path, 'rb') as f:
        return http.HTTPStatus.OK, [('content-type', content_type)], f.read()

static_file_map = {
    '/static/index.js': ('text/javascript', 'client/dist/index.js'),
    '/static/index.js.map': ('text/javascript', 'client/dist/index.js.map'),
    '/static/react.js': ('text/javascript', 'client/node_modules/react/umd/react.development.js'),
    '/static/react-dom.js': ('text/javascript', 'client/node_modules/react-dom/umd/react-dom.development.js'),
    '/static/style.css': ('text/css', 'client/style.css'),
}

class WebServer:
    def __init__(self, handler):
        self.handler = handler

    async def process_request(self, path, request_headers):
        path = path.split('?')[0]
        base_dir = os.path.dirname(__file__) + '/..'

        if path == "/":
            return get_static('text/html', os.path.join(base_dir, 'client/index.html'))

        if path in static_file_map:
            mime_type, local_path = static_file_map[path]
            return get_static(mime_type, os.path.join(base_dir, local_path))

        if path != "/websocket":
            return http.HTTPStatus.NOT_FOUND, [], b'not found'

    async def handle_websocket(self, websocket, path):
        if path == '/websocket':
            await self.handler.run(websocket)

    def main(self, host, port):
        start_server = websockets.serve(
            self.handle_websocket, host, port, process_request=self.process_request,
            origins=['http://%s:%d' % (host, port), 'https://%s:%d' % (host, port)] # type: ignore
        )

        asyncio.get_event_loop().run_until_complete(start_server)
        asyncio.get_event_loop().run_forever()

class Handler:
    def __init__(self, book):
        self.book = book

    async def run(self, websocket):
        await websocket.send(json.dumps({'type': 'document', 'data': self.book.get_document_text()}))

        for id, widget in self.book.widgets.items():
            await websocket.send(json.dumps({'type': 'data', 'id': id,
                                             'data': widget.data_json,
                                             'header': widget.header_json}))

if __name__ == '__main__':
    book = book.Book(document_path='example/simple.rkbk', data_path=':memory:')
    book.store.insert(table_id='foo', row_id=1, data={'n1': 5, 'n2': 'foo'})
    book.refresh()
    WebServer(Handler(book)).main('localhost', 5000)
