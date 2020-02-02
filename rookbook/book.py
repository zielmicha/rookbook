from lxml import etree
from lxml.builder import E
import sqlite3, collections, json
from lxml.cssselect import CSSSelector
import re

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

    def get_row(self, table_id, row_id):
        result = list(self.conn.execute('select payload from rookbook_data where table_id = ? and row_id = ?', (table_id, row_id)))
        if not result: return None
        return json.loads(result[0][0])

    def delete_row(self, table_id, row_id):
        self.conn.execute('delete from rookbook_data where table_id = ? and row_id = ?',
                          (table_id, row_id))

    def set_row(self, table_id, row_id, data):
        self.conn.execute('update rookbook_data set payload = ?, mtime = datetime() where table_id = ? and row_id = ?',
                          (json.dumps(data), table_id, row_id))

    def insert(self, table_id, data):
        # TODO: transaction?
        prev_row_id, = list(self.conn.execute('select max(row_id) from rookbook_data where table_id = ?', (table_id, )))[0]
        row_id = prev_row_id + 1 if prev_row_id is not None else 1
        self.conn.execute('insert into rookbook_data (table_id, mtime, row_id, payload) values (?,datetime(),?,?)',
                          (table_id, row_id, json.dumps(data)))

    def set_field(self, table_id, row_id, key, value):
        row = self.get_row(table_id, row_id)
        if row is None:
            row = {key: value}
            self.conn.execute('insert into rookbook_data (table_id, mtime, row_id, payload) values (?,datetime(),?,?)',
                              (table_id, row_id, json.dumps(row)))
        else:
            row[key] = value
            self.set_row(table_id, row_id, row)

class Book:
    def __init__(self, data_path, document_path):
        self.store = SqliteStore(sqlite3.connect(data_path))
        self.document_path = document_path
        self.widgets = {}
        self._load_doc()

    def refresh(self):
        self._load_data()
        self._run_widgets()

    def get_document_text(self):
        return etree.tostring(self.document, pretty_print=True).decode()

    def set(self, path, value):
        self.widgets[path[0]].set(path[1:], value)
        self.refresh()

    def action(self, path, value):
        self.widgets[path[0]].action(path[1:], value)
        self.refresh()

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

    # --- document modification ----

    def _doc_next_id(self):
        ids = [ x.attrib['id'] for x in self.document.cssselect('[id]') ]
        return '_%d' % (max([ int(id[1:]) for id in ids if re.match(r'_\d+$', id) ]) + 1)

    def doc_add_widget(self, parent_id, element_name):
        target_sheet = self.document.cssselect('rookbook > sheet')[0]
        new_id = self._doc_next_id()
        target_sheet.append(E(element_name, id=new_id))
        self.refresh()

    def doc_set_text(self, selector, new_value):
        elem = self.document.cssselect(selector)[0]
        elem.text = new_value
        self.refresh()

    def doc_delete(self, selector):
        elem = self.document.cssselect(selector)[0]
        parent_map = {c:p for p in self.document.iter() for c in p}
        parent_map[elem].remove(elem)
        self.refresh()

    def doc_add(self, selector, element):
        elem = self.document.cssselect(selector)[0]
        elem.append(element)
        self.refresh()

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
    def __init__(self, id, table_id, type_node):
        self.type_node = type_node
        self.id = id
        self.table_id = table_id

    def to_json(self):
        return {
            'type_node': etree.tostring(self.type_node).decode(),
            'id': self.id,
            'table_id': self.table_id,
        }

class TableWidget(Widget):
    def init(self):
        self.columns = collections.OrderedDict()
        for column in self.widget_node.cssselect('data-col'):
            self.columns[column.attrib['id']] = Column(table_id=self.id, id=column.attrib['id'], type_node=column[0])

        self.header_json = {'columns': [ c.to_json() for k, c in self.columns.items() ]}

    def run(self):
        self.data = self.book.store.get_rows(table_id=self.id)
        self.data_json = [ row.to_json() for row in self.data ]

    def set(self, path, value):
        row_id = path[0]
        column_name = path[1]

        # TODO: validate

        if row_id is None:
            self.book.store.insert(self.id, {column_name: value})
        else:
            self.book.store.set_field(self.id, row_id, column_name, value)

    def action(self, path, value):
        if value['type'] == 'delete':
            self.book.store.delete_row(self.id, path[0])
        else:
            print('unknown action', value)

class TableViewWidget(Widget):
    def init(self):
        use_table_n = self.widget_node.cssselect('use-table')
        if len(use_table_n) != 1:
            print(self.id, ': invalid number of use-table stmts')
            self.columns = {}
            self.header_json = {'columns': []}
            self.table = None
            return

        use_table, = use_table_n
        self.table = self.book.widgets[use_table.attrib['id']]
        assert self.table != self
        # TODO: skip-col

        self.table.request_init()

        self.columns = collections.OrderedDict(self.table.columns)
        for cell in self.widget_node.cssselect('computed-cell'):
            self.columns[cell.attrib['id']] = Column(table_id=self.id, id=cell.attrib['id'], type_node=E('computed', cell))

        self.header_json = {'columns': [ c.to_json() for k, c in self.columns.items() ]}

    def set(self, path, value):
        self.table.set(path, value)

    def action(self, path, value):
        if value['type'] == 'delete':
            self.table.action(path, value)
        else:
            print('unknown action', value)

    def run(self):
        if not self.table:
            self.data_json = []
            return

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
        self.header_json = {
            'type_node': etree.tostring(self.widget_node[0]).decode()
        }

    def run(self):
        row = self.book.store.get_row(self.id, 1)
        self.data = row['value'] if row else None
        self.data_json = self.data

    def set(self, path, value):
        assert len(path) == 0
        self.book.store.set_field(self.id, 1, 'value', value)

class VariableViewWidget(Widget):
    def init(self):
        self.header_json = {'type_node': etree.tostring(E('computed')).decode()}

    def run(self):
        self.data = None
        self.data_json = None

if __name__ == '__main__':
    book = Book(document_path='example/simple.rkbk', data_path=':memory:')
