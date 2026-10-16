import importlib.util
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('live_instrument', Path(__file__).resolve().parents[1] / 'scripts/instrument_strucpp.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class InstrumentationTests(unittest.TestCase):
    def test_only_statements_not_declarations_braces_or_labels(self):
        text = '''#line 1 "project.st"
void Main::run() {
#line 2 "project.st"
    if (flag) {
#line 3 "project.st"
        counter++;
#line 4 "project.st"
    } else {
#line 5 "project.st"
        counter = 0;
#line 6 "project.st"
    }
#line 7 "project.st"
    switch (counter) {
#line 8 "project.st"
        case 1:
#line 9 "project.st"
            counter = 2;
    }
}
'''
        mapping = {'lines': {str(i): {'file': 'programs/Main.st', 'line': i, 'kind': 'programs'} for i in range(1, 10)}, 'routines': [{'file': 'programs/Main.st'}]}
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'project.cpp'
            target.write_text(text)
            points = module.instrument(target, mapping)
            result = target.read_text()
        self.assertEqual(points, [2, 3, 5, 7, 9])
        self.assertNotIn('plc_debug_point(1U)', result)
        self.assertNotIn('plc_debug_point(4U)', result)
        self.assertNotIn('plc_debug_point(8U)', result)
        self.assertEqual(result.count('::plc_debug_routine('), 1)


if __name__ == '__main__':
    unittest.main()
