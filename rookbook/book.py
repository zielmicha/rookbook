from lxml import etree
from lxml.builder import E
import sqlite3, collections, json
from lxml.cssselect import CSSSelector
import re
from copy import deepcopy
from . import common

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
        self.conn.commit()

    def set_row(self, table_id, row_id, data):
        self.conn.execute('update rookbook_data set payload = ?, mtime = datetime() where table_id = ? and row_id = ?',
                          (json.dumps(data), table_id, row_id))
        self.conn.commit()

    def insert(self, table_id, data):
        # TODO: transaction?
        prev_row_id, = list(self.conn.execute('select max(row_id) from rookbook_data where table_id = ?', (table_id, )))[0]
        row_id = prev_row_id + 1 if prev_row_id is not None else 1
        self.conn.execute('insert into rookbook_data (table_id, mtime, row_id, payload) values (?,datetime(),?,?)',
                          (table_id, row_id, json.dumps(data)))
        self.conn.commit()

    def set_field(self, table_id, row_id, key, value):
        row = self.get_row(table_id, row_id)
        if row is None:
            row = {key: value}
            self.conn.execute('insert into rookbook_data (table_id, mtime, row_id, payload) values (?,datetime(),?,?)',
                              (table_id, row_id, json.dumps(row)))
            self.conn.commit()
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

    def evaluate(self, cell, ns):
        if cell.tag == 'python':
            code = cell.text
            try:
                return {'result': repr(eval(code, ns))}
            except Exception as exc:
                return {'error': str(exc)}
        else:
            return {'error': 'unsupported language'}

    def _load_doc(self):
        parser = etree.XMLParser(remove_blank_text=True)
        with open(self.document_path) as f:
            self.document = etree.XML(f.read(), parser=parser)

        print('loaded', self.get_document_text())

        self._doc_add_missing_ids()
        print('loaded', self.get_document_text())

    def _document_updated(self):
        self._doc_add_missing_ids()

        common.write_file(self.document_path, self.get_document_text())

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

    def doc_set_text(self, selector, new_value):
        elem = self.document.cssselect(selector)[0]
        elem.text = new_value
        self._document_updated()
        self.refresh()

    def doc_delete(self, selector):
        elem = self.document.cssselect(selector)[0]
        parent_map = {c:p for p in self.document.iter() for c in p}
        parent_map[elem].remove(elem)
        self._document_updated()
        self.refresh()

    def doc_add(self, selector, element):
        elem = self.document.cssselect(selector)[0]
        elem.append(element)
        self._document_updated()
        self.refresh()

    def doc_set_attr(self, selector, attrs):
        elem = self.document.cssselect(selector)[0]
        for k, v in attrs.items():
            elem.attrib[k] = v
        self._document_updated()
        self.refresh()

    def _doc_add_missing_ids(self):
        for elem in self.document.cssselect('model > *, sheet > *, table > data-col, table-view > computed-col'):
            if 'id' not in elem.attrib:
                elem.attrib['id'] = self._doc_next_id()

    def doc_replace_xml(self, selector, element):
        elem = self.document.cssselect(selector)[0]
        # ignore mismatching tags, only update attrib and children
        elem.clear()
        elem.extend(list(element))
        elem.attrib.clear()
        elem.attrib.update(element.attrib)
        self._document_updated()
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
    def __init__(self, id, table_id, type_node, name):
        self.type_node = type_node
        self.id = id
        self.table_id = table_id
        self.name = name

    def to_json(self):
        return {
            'type_node': etree.tostring(self.type_node).decode(),
            'id': self.id,
            'name': self.name,
            'table_id': self.table_id,
        }

class TableWidget(Widget):
    def init(self):
        self.columns = collections.OrderedDict()
        for column in self.widget_node.cssselect('data-col'):
            self.columns[column.attrib['id']] = Column(table_id=self.id, id=column.attrib['id'], type_node=column[0], name=column.attrib.get('name') or column.attrib['id'])

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

        print('zzz', self.book.get_document_text())
        use_table_n = self.widget_node.cssselect('use-table')
        if len(use_table_n) != 1:
            print(self.id, ': invalid number of use-table stmts')
            self.columns = {}
            self.header_json = {'columns': []}
            self.table = None
            return

        use_table, = use_table_n
        self.table = self.book.widgets[use_table.attrib['href']]
        assert self.table != self
        # TODO: skip-col

        self.table.request_init()

        self.columns = collections.OrderedDict(self.table.columns)
        for col in self.widget_node.cssselect('computed-col'):
            self.columns[col.attrib['id']] = Column(table_id=self.id, id=col.attrib['id'], type_node=E('computed', deepcopy(col)),
                                                    name=col.attrib.get('name') or col.attrib['id'])

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
            for cell in self.widget_node.cssselect('computed-col'):
                row_ns = {
                    'row': new_row
                }
                new_row = Row(new_row._id, dict(new_row._data, **{cell.attrib['name']: self.book.evaluate(cell[0], row_ns)}))

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
