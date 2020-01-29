from lxml import etree
from lxml.builder import E
import sqlite3, collections, json
from lxml.cssselect import CSSSelector

class DefinitionError(Exception): pass

class Row:
    def __init__(self, id, data):
        self._id = id
        assert isinstance(data, dict), type(data)
        self._data = data

    def to_json(self):
        return dict(self._data, _id=self._id)

    def __getattr__(self, name):
        try:
            return self._data[name]
        except KeyError:
            raise AttributeError()

class SqliteStore:
    def __init__(self, conn):
        self.conn = conn

        self.conn.execute('create table if not exists rookbook_data (table_id text, mtime integer, row_id integer, payload json)')

    def get_rows(self, table_id):
        return [ Row(id, json.loads(data))
                 for id, data in self.conn.execute('select row_id, payload from rookbook_data where table_id = ?', (table_id, )) ]

    def insert(self, table_id, row_id, data):
        self.conn.execute('insert into rookbook_data (table_id, mtime, row_id, payload) values (?,datetime(),?,?)',
                          (table_id, row_id, json.dumps(data)))

class Book:
    def __init__(self, data_path, document_path):
        self.store = SqliteStore(sqlite3.connect(data_path))
        self.document_path = document_path
        self.widgets = {}

    def refresh(self):
        self._load_doc()
        self._load_data()
        self._run_widgets()

    def get_document_text(self):
        with open(self.document_path) as f:
            return f.read()

    def _load_doc(self):
        parser = etree.XMLParser(remove_blank_text=True)
        with open(self.document_path) as f:
            self.document = etree.XML(f.read(), parser=parser)

    def _load_data(self):
        model_section = self.document.cssselect('rookbook > model')[0]

        for child in model_section:
            self._load_widget(child)

        for sheet in self.document.cssselect('rookbook > sheet'):
            for child in sheet:
                self._load_widget(child)

    def _load_widget(self, widget_node):
        widget_types = {
            'table': TableWidget,
            'table-view': TableViewWidget,
            'variable': VariableWidget,
            'variable-view': VariableViewWidget,
        }
        if widget_node.tag in widget_types:
            self.widgets[widget_node.attrib['id']] = widget_types[widget_node.tag](self, widget_node)
        elif widget_node.tag in [etree.Comment, 'text']:
            pass
        else:
            print('unknown node', widget_node.tag, widget_node)

    def _run_widgets(self):
        for widget in self.widgets.values():
            widget.request_init()

        for widget in self.widgets.values():
            widget.request_run()

class Widget:
    def __init__(self, book, widget_node):
        self.book = book
        self.widget_node = widget_node
        self.id = self.widget_node.attrib['id']
        self.header_json = None

        self._init_done = False
        self._run_done = False

    def request_init(self):
        if not self._init_done:
            self.init()
            self._init_done = True

    def request_run(self):
        if not self._run_done:
            self.run()
            self._run_done = True

class Column:
    def __init__(self, type_node):
        self.type_node = type_node

    def to_json(self):
        return {
            'type_node': etree.tostring(self.type_node).decode()
        }

class TableWidget(Widget):
    def init(self):
        self.columns = collections.OrderedDict()
        for column in self.widget_node.cssselect('data-col'):
            self.columns[column.attrib['id']] = Column(type_node=column[0])

        self.header_json = {'columns': [ (k, c.to_json()) for k, c in self.columns.items() ]}

    def run(self):
        self.data = self.book.store.get_rows(table_id=self.id)
        self.data_json = [ row.to_json() for row in self.data ]

class TableViewWidget(Widget):
    def init(self):
        use_table_n = self.widget_node.cssselect('use-table')
        if len(use_table_n) != 1: raise DefinitionError('invalid number of use-table stmts')

        use_table, = use_table_n
        self.table = self.book.widgets[use_table.attrib['id']]
        assert self.table != self
        # TODO: skip-col

        self.table.request_init()

        self.columns = collections.OrderedDict(self.table.columns)
        for cell in self.widget_node.cssselect('computed-cell'):
            self.columns[cell.attrib['id']] = Column(type_node=E('computed', cell))

        self.header_json = {'columns': [ (k, c.to_json()) for k, c in self.columns.items() ]}

    def run(self):
        self.data = []
        for row in self.table.data:
            new_row = row
            for cell in self.widget_node.cssselect('computed-cell'):
                row_ns = {
                    'row': collections.namedtuple('Row', new_row.keys())(new_row)
                }
                new_row = Row(new_row._id, dict(new_row._data, **{cell.attrib['id']: self.book.evaluate(cell[0], row_ns)}))

            self.data.append(new_row)

        self.data_json = [ row.to_json() for row in self.data ]

class VariableWidget(Widget):
    def init(self):
        pass

    def run(self):
        self.data = None
        self.data_json = None

class VariableViewWidget(Widget):
    def init(self):
        pass

    def run(self):
        self.data = None
        self.data_json = None

if __name__ == '__main__':
    book = Book(document_path='example/simple.rkbk', data_path=':memory:')
