# SiteGenie Setup Guide

This document provides detailed instructions for setting up SiteGenie in both development and production environments. SiteGenie uses Docker for containerization, ensuring consistent environments across different systems.

## Prerequisites

Before setting up SiteGenie, ensure you have the following installed:

- [Docker](https://docs.docker.com/get-docker/) (version 20.10 or higher)
- [Docker Compose](https://docs.docker.com/compose/install/) (version 2.0 or higher)
- [Git](https://git-scm.com/downloads) (version 2.25 or higher)
- [Node.js](https://nodejs.org/) (version 16 or higher, for local development only)
- [npm](https://www.npmjs.com/) (version 8 or higher, for local development only)

## Clone the Repository

```bash
# Clone the repository
git clone https://github.com/yourusername/SiteGenie.git

# Navigate to the project directory
cd SiteGenie
```

## Directory Structure Setup

Create the necessary directories for Docker volumes:

```bash
mkdir -p ./data/db
mkdir -p ./data/logs
mkdir -p ./config
```

## Environment Configuration

1. Create a `.env` file in the root directory:

```bash
cp .env.example .env
```

2. Open the `.env` file and configure the following variables:

```
# App Configuration
NODE_ENV=development
PORT=3000

# Database Configuration
DB_HOST=mongodb
DB_PORT=27017
DB_NAME=sitegenie
DB_USER=sitegenieuser
DB_PASS=your_secure_password

# API Keys
OPENAI_API_KEY=your_openai_api_key
GOOGLE_API_KEY=your_google_api_key

# Other Settings
LOG_LEVEL=info
ENABLE_AGENT_SWARM=true
```

Adjust these values according to your specific requirements and API credentials.

## Docker Compose Configuration

### Development Environment

Create a `docker-compose.yml` file in the root directory:

```yaml
version: '3.8'

services:
  app:
    build:
      context: .
      dockerfile: Dockerfile.dev
    container_name: sitegenie-app
    ports:
      - "3000:3000"
    volumes:
      - .:/app
      - /app/node_modules
    environment:
      - NODE_ENV=development
    env_file:
      - .env
    depends_on:
      - mongodb

  mongodb:
    image: mongo:latest
    container_name: sitegenie-mongodb
    ports:
      - "27017:27017"
    volumes:
      - ./data/db:/data/db
    environment:
      - MONGO_INITDB_ROOT_USERNAME=${DB_USER}
      - MONGO_INITDB_ROOT_PASSWORD=${DB_PASS}
      - MONGO_INITDB_DATABASE=${DB_NAME}

networks:
  default:
    name: sitegenie-network
```

### Production Environment

Create a `docker-compose.prod.yml` file:

```yaml
version: '3.8'

services:
  app:
    build:
      context: .
      dockerfile: Dockerfile.prod
    container_name: sitegenie-app-prod
    restart: always
    ports:
      - "80:3000"
    environment:
      - NODE_ENV=production
    env_file:
      - .env
    depends_on:
      - mongodb

  mongodb:
    image: mongo:latest
    container_name: sitegenie-mongodb-prod
    restart: always
    volumes:
      - ./data/db:/data/db
    environment:
      - MONGO_INITDB_ROOT_USERNAME=${DB_USER}
      - MONGO_INITDB_ROOT_PASSWORD=${DB_PASS}
      - MONGO_INITDB_DATABASE=${DB_NAME}

networks:
  default:
    name: sitegenie-network-prod
```

## Running SiteGenie

### Development Environment

Start the application in development mode:

```bash
docker-compose up
```

To run in detached mode (background):

```bash
docker-compose up -d
```

### Production Environment

Start the application in production mode:

```bash
docker-compose -f docker-compose.prod.yml up -d
```

## Stopping SiteGenie

### Development Environment

```bash
docker-compose down
```

### Production Environment

```bash
docker-compose -f docker-compose.prod.yml down
```

## Viewing Logs

To view logs for the running containers:

### Development Environment

```bash
# View all logs
docker-compose logs

# Follow logs
docker-compose logs -f

# View logs for a specific service
docker-compose logs app
docker-compose logs mongodb
```

### Production Environment

```bash
# View all logs
docker-compose -f docker-compose.prod.yml logs

# Follow logs
docker-compose -f docker-compose.prod.yml logs -f

# View logs for a specific service
docker-compose -f docker-compose.prod.yml logs app
docker-compose -f docker-compose.prod.yml logs mongodb
```

## Testing

Run the test suite:

```bash
docker-compose exec app npm test
```

## Rebuilding Containers

If you make changes to the Dockerfile or need to rebuild the containers:

```bash
# Development
docker-compose build

# Production
docker-compose -f docker-compose.prod.yml build
```

## Accessing the Application

Once the application is running, you can access it at:

- Development: http://localhost:3000
- Production: http://your-server-ip (or your domain if configured)

## Troubleshooting

1. **Permission issues with mounted volumes:**
   ```bash
   sudo chown -R $USER:$USER ./data
   ```

2. **Port conflicts:**
   If port 3000 or 27017 is already in use, modify the port mappings in the docker-compose files.

3. **Container not starting:**
   ```bash
   docker-compose logs app
   ```
   Check the logs for any error messages.

## Agent System

SiteGenie uses a swarm of specialized AI agents to perform various SEO and website optimization tasks. Each agent has specific expertise in areas such as on-page SEO, content marketing, technical SEO, etc. The agent system is automatically configured when you start the application.

For more information about SiteGenie's features and capabilities, refer to the [README.md](README.md) file.
