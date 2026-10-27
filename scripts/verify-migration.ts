/**
 * P1 migration thresholds: interpreter discovery + `.idea` import.
 *
 * Both are pure file-system readers, so the suite builds a throwaway PyCharm
 * project in a temp directory and checks the parts that would silently mislead:
 *
 *   - XML: a `>` inside an attribute, entities, CDATA, unclosed tags
 *   - run configs: macros expanded, workdir/env kept, templates skipped,
 *     duplicates reported instead of silently overwriting
 *   - interpreters: a project `.venv` beats PATH, a pin beats everything,
 *     and the SDK name from `misc.xml` breaks ties
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeEntities, findAll, options, parseXml, child } from '../src/util/xml.js';
import { expandMacros, importIdeaProject } from '../src/langs/ideaImport.js';
import { discoverInterpreters, pickInterpreter, shortVersion } from '../src/langs/interpreters.js';

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

function write(path: string, content: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

// ---------------------------------------------------------------- XML

const doc = parseXml(`<?xml version="1.0" encoding="UTF-8"?>
<!-- a comment with <tags> inside -->
<project version="4">
  <component name="ProjectRootManager" project-jdk-name="Python 3.13 (proj)" />
  <configuration name="a &amp; b" pattern="x > y" note='single'>
    <option name="SCRIPT_NAME" value="$PROJECT_DIR$/main.py" />
    <envs><env name="FOO" value="1" /></envs>
    <![CDATA[raw <text> & stuff]]>
  </configuration>
  <unclosed>
</project>`);

check('xml: declaration and comment are skipped', findAll(doc, 'component').length === 1);
check(
  'xml: entity in attribute is decoded',
  findAll(doc, 'configuration')[0]?.attrs.name === 'a & b',
  findAll(doc, 'configuration')[0]?.attrs.name,
);
check(
  'xml: ">" inside a quoted attribute does not end the tag',
  findAll(doc, 'configuration')[0]?.attrs.pattern === 'x > y',
  findAll(doc, 'configuration')[0]?.attrs.pattern,
);
check("xml: single-quoted attribute", findAll(doc, 'configuration')[0]?.attrs.note === 'single');
check(
  'xml: self-closing option keeps its attributes',
  options(findAll(doc, 'configuration')[0])['SCRIPT_NAME'] === '$PROJECT_DIR$/main.py',
);
check('xml: CDATA reaches the parent text', /raw <text> & stuff/.test(findAll(doc, 'configuration')[0]?.text ?? ''));
check('xml: unclosed tags are tolerated', !!child(doc, 'project'));
check('xml: decodeEntities handles numeric refs', decodeEntities('&#65;&#x42;&lt;') === 'AB<');
check('xml: unknown entity is left alone', decodeEntities('&nope;') === '&nope;');

// ---------------------------------------------------------------- .idea import

const root = mkdtempSync(join(tmpdir(), 'nlg-idea-'));
try {
  write(join(root, '.idea', 'misc.xml'), `<project version="4">
  <component name="ProjectRootManager" version="2" project-jdk-name="Python 3.13 (proj)" project-jdk-type="Python SDK" />
</project>`);
  write(join(root, '.idea', 'modules.xml'), `<project version="4">
  <component name="ProjectModuleManager"><modules>
    <module fileurl="file://$PROJECT_DIR$/proj.iml" filepath="$PROJECT_DIR$/proj.iml" />
  </modules></component>
</project>`);
  write(join(root, '.idea', 'runConfigurations', 'main.xml'), `<component name="ProjectRunConfigurationManager">
  <configuration default="false" name="main" type="PythonConfigurationType" factoryName="Python">
    <option name="SCRIPT_NAME" value="$PROJECT_DIR$/src/main.py" />
    <option name="PARAMETERS" value="--fast 1" />
    <option name="WORKING_DIRECTORY" value="$PROJECT_DIR$/src" />
    <envs><env name="MODE" value="dev" /></envs>
  </configuration>
  <configuration default="true" name="Python" type="PythonConfigurationType" factoryName="Python">
    <option name="SCRIPT_NAME" value="" />
  </configuration>
  <configuration default="false" name="no-script" type="PythonConfigurationType" factoryName="Python">
    <option name="PARAMETERS" value="x" />
  </configuration>
</component>`);
  write(join(root, '.run', 'web.xml'), `<component name="ProjectRunConfigurationManager">
  <configuration default="false" name="web" type="NodeJSConfigurationType" factoryName="Node.js">
    <option name="PATH_TO_JS_FILE" value="$PROJECT_DIR$/web/index.js" />
    <option name="PARAMETERS" value="serve" />
  </configuration>
  <configuration default="false" name="main" type="PythonConfigurationType" factoryName="Python">
    <option name="SCRIPT_NAME" value="$PROJECT_DIR$/other.py" />
  </configuration>
</component>`);

  const imported = await importIdeaProject(root);
  check('idea: not missing', imported.missing === false);
  check('idea: project SDK read from misc.xml', imported.projectSdk === 'Python 3.13 (proj)', String(imported.projectSdk));
  check('idea: module name read from modules.xml', imported.modules.join(',') === 'proj', imported.modules.join(','));
  check('idea: two configurations imported', imported.configurations.length === 2, String(imported.configurations.length));

  const main = imported.configurations.find((c) => c.name === 'main');
  check('idea: $PROJECT_DIR$ expanded to a relative script', main?.script === 'src/main.py', String(main?.script));
  check('idea: scriptPath is absolute', !!main?.scriptPath && main.scriptPath.includes('src'), String(main?.scriptPath));
  check('idea: parameters preserved', main?.parameters === '--fast 1', String(main?.parameters));
  check('idea: workdir made project-relative', main?.workdir === 'src', String(main?.workdir));
  check('idea: envs preserved', main?.env.MODE === 'dev', JSON.stringify(main?.env));
  check('idea: language guessed from extension', main?.language === 'python', String(main?.language));

  const web = imported.configurations.find((c) => c.name === 'web');
  check('idea: .run/ is read too', !!web && web.source === '.run/web.xml', String(web?.source));
  check('idea: PATH_TO_JS_FILE is a script key', web?.script === 'web/index.js', String(web?.script));
  check('idea: javascript guessed for .js', web?.language === 'javascript', String(web?.language));

  check(
    'idea: default="true" template is skipped',
    !imported.configurations.some((c) => c.name === 'Python'),
  );
  check(
    'idea: a config without a script is reported',
    imported.warnings.some((w) => w.includes('no-script')),
    imported.warnings.join(' | '),
  );
  check(
    'idea: a duplicate name is reported, not silently merged',
    imported.warnings.some((w) => w.includes('duplicate name "main"')),
    imported.warnings.join(' | '),
  );

  const empty = await importIdeaProject(join(root, 'not-a-project'));
  check('idea: a project without .idea reports missing', empty.missing === true && empty.configurations.length === 0);

  check(
    'idea: $USER_HOME$ expands',
    expandMacros('$USER_HOME$/x', root).includes('x') && !expandMacros('$USER_HOME$/x', root).includes('$USER_HOME$'),
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}

// ---------------------------------------------------------------- interpreters

const proj = mkdtempSync(join(tmpdir(), 'nlg-py-'));
const home = mkdtempSync(join(tmpdir(), 'nlg-home-'));
try {
  write(join(proj, '.venv', 'pyvenv.cfg'), 'home = C:\\Python313\n');
  write(join(proj, '.venv', 'Scripts', 'python.exe'), 'MZ fake');
  write(join(proj, 'venv', 'pyvenv.cfg'), 'home = C:\\Python312\n');
  write(join(proj, 'venv', 'Scripts', 'python.exe'), 'MZ fake');
  write(join(proj, 'main.py'), 'print(1)\n');

  const sysDir = join(home, 'sys');
  write(join(sysDir, 'python.exe'), 'MZ fake');

  const condaEnv = join(home, 'miniconda', 'envs', 'ml');
  write(join(condaEnv, 'Scripts', 'python.exe'), 'MZ fake');
  write(join(home, '.conda', 'environments.txt'), `${condaEnv}\n${join(home, 'miniconda')}\n`);

  const pyenvVer = join(home, '.pyenv', 'pyenv-win', 'versions', '3.11.9');
  write(join(pyenvVer, 'python.exe'), 'MZ fake');

  const found = await discoverInterpreters(proj, 'python', {
    home,
    pathEnv: sysDir,
    probe: null,
  });
  const paths = found.map((c) => c.path.replace(/\\/g, '/'));
  check('interp: project .venv found', paths.some((p) => p.includes('/.venv/Scripts/python.exe')));
  check('interp: second project env found', paths.some((p) => p.includes('/venv/Scripts/python.exe')));
  check('interp: conda env found', paths.some((p) => p.includes('/miniconda/envs/ml/')));
  check('interp: pyenv version found', paths.some((p) => p.includes('/3.11.9/')));
  check('interp: PATH entry found', paths.some((p) => p.includes('/sys/python.exe')));
  check('interp: no duplicate paths', new Set(paths).size === paths.length, String(paths.length));
  check('interp: .venv sorts first', found[0]?.kind === 'venv' && found[0].source === '.venv', `${found[0]?.kind}/${found[0]?.source}`);
  check('interp: kinds are labelled', found.every((c) => c.label.length > 0));

  const noProbe = await discoverInterpreters(proj, 'python', { home, pathEnv: '', probe: null });
  check('interp: PATH can be excluded', !noProbe.some((c) => c.kind === 'path'));

  check('interp: pick prefers the project venv', pickInterpreter(found)?.source === '.venv');
  check(
    'interp: a pin wins over the venv',
    pickInterpreter(found, { pinned: found[2].path })?.path === found[2].path,
  );
  check(
    'interp: an unknown pin falls back to the venv',
    pickInterpreter(found, { pinned: 'C:/nope/python.exe' })?.source === '.venv',
  );
  check(
    'interp: SDK name marks a match',
    (await discoverInterpreters(proj, 'python', { home, pathEnv: '', probe: null, sdkName: 'Python 3.11.9 (pyenv)' })).some(
      (c) => c.sdkMatch,
    ),
  );
  check('interp: unknown language yields nothing', (await discoverInterpreters(proj, 'cobol')).length === 0);
  check('interp: shortVersion trims the prefix', shortVersion('Python 3.13.14') === '3.13.14');
  check('interp: shortVersion tolerates raw numbers', shortVersion('go version go1.27.2 windows/amd64') === '1.27.2');
} finally {
  rmSync(proj, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
}

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} checks passed`);
if (passed !== results.length) process.exitCode = 1;
