import asyncio, http, os, io, glob, websockets, json
from lxml import etree
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
        self.websockets = []

    async def run(self, websocket):
        await self.send_full_update(websocket)

        self.websockets.append(websocket)
        try:
            async for msg in websocket:
                await self.handle_message(websocket, msg)
        finally:
            self.websockets.remove(websocket)

    async def send_full_update(self, websocket):
        document = self.book.get_document_text()
        print('send', document)
        await websocket.send(json.dumps({'type': 'document', 'data': '<!-- gen -->\n' + document}))

        for id, widget in self.book.widgets.items():
            await websocket.send(json.dumps({'type': 'data', 'id': id,
                                             'data': widget.data_json,
                                             'header': widget.header_json}))

    async def full_update(self):
        # TODO: async
        for ws in self.websockets:
            await self.send_full_update(ws)

    async def send_result(self, websocket, req, data):
        await websocket.send(json.dumps({
            'type': 'response',
            'id': req['call_id'],
            'data': data
        }))

    async def handle_message(self, websocket, msg_data):
        print('msg', msg_data)
        msg = json.loads(msg_data)
        if msg['type'] == 'set':
            self.book.set(msg['path'], msg['value'])
            await self.full_update()
            await websocket.send(json.dumps({'type': 'set-done', 'epoch': msg['epoch']}))
        elif msg['type'] == 'action':
            self.book.action(msg['path'], msg['value'])
            await self.full_update()
        elif msg['type'] == 'doc-add-widget':
            self.book.doc_add_widget(parent_id=msg['parentId'], element_name=msg['element'])
            await self.full_update()
        elif msg['type'] == 'doc-set-text':
            self.book.doc_set_text(selector=msg['selector'], new_value=msg['new_value'])
            await self.full_update()
        elif msg['type'] == 'doc-delete':
            self.book.doc_delete(selector=msg['selector'])
            await self.full_update()
        elif msg['type'] == 'doc-add':
            parser = etree.XMLParser(remove_blank_text=True)
            self.book.doc_add(selector=msg['selector'], element=etree.XML(msg['xml'], parser=parser))
            await self.full_update()
        elif msg['type'] == 'doc-set-attr':
            self.book.doc_set_attr(selector=msg['selector'], attrs=msg['attrs'])
            await self.full_update()
        elif msg['type'] == 'doc-replace-xml':
            parser = etree.XMLParser(remove_blank_text=True)
            try:
                xml = etree.XML(msg['new_xml'], parser=parser)
            except Exception:
                await self.send_result(websocket, msg, {'error': 'failed to parse XML'})
            else:
                self.book.doc_replace_xml(msg['selector'], xml)
                await self.send_result(websocket, msg, {'ok': True})
                await self.full_update()
        else:
            print('unknown message', msg)

if __name__ == '__main__':
    import sys
    book = book.Book(document_path=sys.argv[1], data_path=sys.argv[2])
    book.refresh()

    from . import common
    common.start_asyncio_ipython(local_ns=globals())

    WebServer(Handler(book)).main('localhost', 5000)
