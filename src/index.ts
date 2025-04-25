import path from 'path'
import fs from 'fs'
import yaml from 'js-yaml'
import { z } from 'zod'
import { execSync } from 'child_process'
import inquirer from 'inquirer'

// Types
type Deps = { apps: string[]; packages: string[] }
type Repo = { name: string; deps: Deps }
type ReposWithDeps = { apps: Repo[]; packages: Repo[] }
type Repos = { apps: string[]; packages: string[] }

// Schema validation
const DepsSchema = z.object({
  apps: z.array(z.string()).optional(),
  packages: z.array(z.string()).optional(),
})

// Functions for dependency management
function read_deps(repo_path: string): Deps {
  const deps_file_path = path.join(repo_path, 'deps.yaml')
  if (!fs.existsSync(deps_file_path)) return { apps: [], packages: [] }

  const deps_file = fs.readFileSync(deps_file_path, 'utf-8')
  const parsedDeps = yaml.load(deps_file)
  if (parsedDeps === undefined) return { apps: [], packages: [] }

  const validatedDeps = DepsSchema.parse(parsedDeps)
  return {
    apps: validatedDeps.apps || [],
    packages: validatedDeps.packages || [],
  }
}

function get_repos(): Repos {
  let apps = fs.existsSync('apps') ? fs.readdirSync('apps').filter((dir) => fs.statSync(path.join('apps', dir)).isDirectory()) : []

  let packages = fs.existsSync('packages') ? fs.readdirSync('packages').filter((dir) => fs.statSync(path.join('packages', dir)).isDirectory()) : []

  // Validate structure
  for (const app of apps) {
    ;['protos/index.proto', 'gen-grpc-client.sh'].forEach((file) => {
      if (!fs.existsSync(path.join('apps', app, file))) throw new Error(`${file} not found in ${path.join('apps', app)}`)
    })
  }

  for (const pkg of packages) {
    ;['deps.yaml', 'protos/index.proto', 'gen-grpc-client.sh'].forEach((file) => {
      if (!fs.existsSync(path.join('packages', pkg, file))) console.error(`${file} not found in ${path.join('packages', pkg)}`)
    })
  }

  return { apps, packages }
}

function get_repos_with_deps(): ReposWithDeps {
  const repos = get_repos()
  return {
    apps: repos.apps.map((app) => ({ name: app, deps: read_deps(path.join('apps', app)) })),
    packages: repos.packages.map((pkg) => ({ name: pkg, deps: read_deps(path.join('packages', pkg)) })),
  }
}

// Check for circular dependencies
function check_circular_deps(repos_with_deps: ReposWithDeps): boolean {
  const all_repos = repos_with_deps.apps.concat(repos_with_deps.packages)
  const visited = new Set<string>()
  const stack = new Set<string>()

  function visit(repo: Repo): boolean {
    if (stack.has(repo.name)) return true
    if (visited.has(repo.name)) return false

    visited.add(repo.name)
    stack.add(repo.name)

    const all_deps = [...repo.deps.apps, ...repo.deps.packages]
    for (const dep_name of all_deps) {
      const dep = all_repos.find((r) => r.name === dep_name)
      if (dep && visit(dep)) return true
    }

    stack.delete(repo.name)
    return false
  }

  for (const repo of all_repos) {
    if (visit(repo)) {
      console.log(`⚠️ Circular dependency detected in ${repo.name}`)
      return true
    }
  }

  return false
}

// Process dependencies (link or copy)
function process_dep(src_path: string, target_path: string, is_link: boolean) {
  const target_dir = path.dirname(target_path)
  fs.mkdirSync(target_dir, { recursive: true })

  if (fs.existsSync(target_path)) {
    if (fs.lstatSync(target_path).isSymbolicLink()) {
      fs.unlinkSync(target_path)
    } else {
      fs.rmSync(target_path, { recursive: true, force: true })
    }
  }

  if (is_link) {
    fs.symlinkSync(path.resolve(src_path), target_path, 'dir')
    console.log(`🔗 Linked ${src_path} to ${target_path}`)
  } else {
    fs.cpSync(path.resolve(src_path), target_path, {
      recursive: true,
      filter: (src) => !src.includes('node_modules') && !src.includes('.git'),
    })
    console.log(`📦 Copied ${src_path} to ${target_path}`)
  }
}

// Process all dependencies
function process_all_deps(repos: ReposWithDeps, is_link: boolean) {
  const action = is_link ? 'Linking' : 'Building'
  console.log(`${action} all dependencies...`)

  // Process packages first, then apps
  for (const type of ['packages', 'apps']) {
    for (const repo of repos[type as keyof ReposWithDeps]) {
      console.log(`Processing ${repo.name}...`)

      for (const pkg of repo.deps.packages) {
        const src_path = path.join('packages', pkg)
        const target_path = path.join(type, repo.name, 'repo', 'packages', pkg, 'contents')
        process_dep(src_path, target_path, is_link)
      }

      for (const app of repo.deps.apps) {
        const src_path = path.join('apps', app)
        const target_path = path.join(type, repo.name, 'repo', 'apps', app, 'contents')
        process_dep(src_path, target_path, is_link)
      }
    }
  }

  console.log(`✅ All dependencies ${is_link ? 'linked' : 'built'} successfully`)
}

// Generate gRPC clients
function create_grpc_client(repo_path: string, dep_path: string) {
  if (!fs.existsSync(path.join(dep_path, 'protos', 'index.proto'))) throw new Error(`index.proto not found in ${dep_path}/protos`)

  const client_dir = path.join(repo_path, 'repo', dep_path, 'client')
  fs.mkdirSync(client_dir, { recursive: true })
  fs.cpSync(path.join(dep_path, 'protos'), path.join(client_dir, 'protos'), { recursive: true })

  const protos_path = path.join('repo', dep_path, 'client', 'protos')
  const proto_file_path = path.join(protos_path, 'index.proto')
  const output_path = path.join('repo', dep_path, 'client')

  try {
    execSync(
      `cd ${repo_path} && \
      PROTO_FILE_PATH="${proto_file_path}" \
      PROTOS_PATH="${protos_path}" \
      OUTPUT_PATH="${output_path}" \
      sh ./gen-grpc-client.sh`,
      { stdio: 'inherit' }
    )
  } catch (error) {
    console.error(`Error generating gRPC client for ${repo_path} from ${dep_path}:`, error)
  }
}

function create_all_grpc_clients(repos: ReposWithDeps) {
  console.log('Generating all gRPC clients...')

  for (const type of ['apps', 'packages']) {
    for (const repo of repos[type as keyof ReposWithDeps]) {
      for (const dep_type of ['packages', 'apps']) {
        for (const dep of repo.deps[dep_type as keyof Deps]) {
          const dep_path = path.join(dep_type, dep)
          create_grpc_client(path.join(type, repo.name), dep_path)
        }
      }
    }
  }

  console.log('✅ All gRPC clients generated successfully')
}

// Create a new app or package
function create_new_repo(type: 'app' | 'package', name: string) {
  const base_path = type === 'app' ? 'apps' : 'packages'
  const repo_path = path.join(base_path, name)

  if (fs.existsSync(repo_path)) {
    console.error(`❌ ${type} "${name}" already exists`)
    return false
  }

  console.log(`Creating new ${type}: ${name}`)

  // Create directory structure and files
  fs.mkdirSync(path.join(repo_path, 'protos'), { recursive: true })

  // deps.yaml
  fs.writeFileSync(path.join(repo_path, 'deps.yaml'), 'apps: []\npackages: []\n')

  fs.writeFileSync(path.join(repo_path, 'protos', 'index.proto'), '// Define your proto files here\n')

  // gen-grpc-client.sh
  const script = '# Replace with actual implementation for your language'
  fs.writeFileSync(path.join(repo_path, 'gen-grpc-client.sh'), script)
  fs.chmodSync(path.join(repo_path, 'gen-grpc-client.sh'), 0o755)

  console.log(`✅ Created new ${type}: ${name}`)
  return true
}

// Command handlers
const commands = {
  link: async () => {
    const repos = get_repos_with_deps()
    if (check_circular_deps(repos)) {
      console.error('❌ Circular dependencies detected!')
      return
    }
    process_all_deps(repos, true)
    create_all_grpc_clients(repos)
    await show_menu()
  },

  build: async () => {
    const repos = get_repos_with_deps()
    if (check_circular_deps(repos)) {
      console.error('❌ Circular dependencies detected!')
      return
    }
    process_all_deps(repos, false)
    create_all_grpc_clients(repos)
    await show_menu()
  },

  create_app: async () => {
    const { name } = await inquirer.prompt([
      {
        type: 'input',
        name: 'name',
        message: 'Enter app name:',
        validate: (input) => !!input.trim() || 'Name cannot be empty',
      },
    ])

    create_new_repo('app', name)
    await show_menu()
  },

  create_package: async () => {
    const { name } = await inquirer.prompt([
      {
        type: 'input',
        name: 'name',
        message: 'Enter package name:',
        validate: (input) => !!input.trim() || 'Name cannot be empty',
      },
    ])

    create_new_repo('package', name)
    await show_menu()
  },
}

// Main menu
async function show_menu() {
  console.clear()
  console.log('🛠️  Polyglot Monorepo CLI\n')

  const { action } = await inquirer.prompt([
    {
      type: 'list',
      name: 'action',
      message: 'What would you like to do?',
      choices: [
        { name: 'Link dependencies (development mode)', value: 'link' },
        { name: 'Build dependencies (deployment mode)', value: 'build' },
        { name: 'Create new app', value: 'create_app' },
        { name: 'Create new package', value: 'create_package' },
        { name: 'Exit', value: 'exit' },
      ],
    },
  ])

  if (action === 'exit') {
    console.log('Goodbye! 👋')
    process.exit(0)
  }

  await commands[action]()
}

// Start the CLI
;(async () => {
  try {
    await show_menu()
  } catch (error) {
    console.error('❌ Error:', error)
    process.exit(1)
  }
})()
