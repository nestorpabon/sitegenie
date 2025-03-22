/**
 * SiteGenie Main Entry Point
 * Handles command-line interface and orchestrates the application flow
 */
const fs = require('fs');
const path = require('path');
const { program } = require('commander');
const open = require('open');
const { version } = require('./package.json');

// Import core modules
const { analyzeNiche } = require('./src/nicheAnalysis');
const { createSite } = require('./src/siteCreator');
const { generateContent, createContent } = require('./src/contentGenerator');
const { registerDomain, retrieveDomainSearchResults } = require('./src/domainRegistry');
const { getNichePerformanceData, generateReport, generateNicheComparisonReport } = require('./src/reports');
const logger = require('./src/utils/logger');

/**
 * Generates and optionally opens a niche performance report
 * 
 * @param {Object} options - Report generation options
 * @param {string} [options.outputDir='./reports'] - Directory to save the report
 * @param {string} [options.filename] - Custom filename
 * @param {string} [options.startDate] - Start date for report data (ISO string)
 * @param {string} [options.endDate] - End date for report data (ISO string)
 * @param {string} [options.metrics] - Comma-separated list of metrics to include
 * @param {boolean} [options.open=true] - Whether to open the report after generation
 * @returns {Promise<void>}
 */
async function generateAndRetrieveReport(options) {
  const {
    outputDir = './reports',
    filename,
    startDate,
    endDate,
    metrics,
    open: shouldOpen = true
  } = options;

  // Validate output directory
  if (!fs.existsSync(outputDir)) {
    try {
      fs.mkdirSync(outputDir, { recursive: true });
      logger.info(`Created output directory: ${outputDir}`);
    } catch (error) {
      logger.error(`Failed to create output directory: ${error.message}`);
      return;
    }
  }

  // Parse metrics if provided
  const metricsArray = metrics ? metrics.split(',').map(m => m.trim()) : undefined;

  // Parse dates if provided
  const startDateObj = startDate ? new Date(startDate) : undefined;
  const endDateObj = endDate ? new Date(endDate) : undefined;

  // Validate dates
  if (startDate && isNaN(startDateObj.getTime())) {
    logger.error(`Invalid start date: ${startDate}`);
    return;
  }

  if (endDate && isNaN(endDateObj.getTime())) {
    logger.error(`Invalid end date: ${endDate}`);
    return;
  }

  try {
    // Generate the report
    logger.info('Generating niche performance report...');
    
    const reportResult = await generateReport({
      outputDir,
      filename,
      startDate: startDateObj,
      endDate: endDateObj,
      metrics: metricsArray
    });

    if (reportResult.success) {
      logger.info(`Report generated successfully: ${reportResult.reportPath}`);
      logger.info(`Total records: ${reportResult.recordCount}`);
      
      // Open the report if requested
      if (shouldOpen) {
        try {
          await open(reportResult.reportPath);
          logger.info('Opened report file with default application');
        } catch (openError) {
          logger.warn(`Could not open report file: ${openError.message}`);
          logger.info(`Report is available at: ${reportResult.reportPath}`);
        }
      }
    } else {
      logger.error(`Failed to generate report: ${reportResult.error}`);
    }
  } catch (error) {
    logger.error('An unexpected error occurred while generating the report:', error);
  }
}

/**
 * Generates a niche comparison report between two niches
 * 
 * @param {string} niche1Id - ID of first niche
 * @param {string} niche2Id - ID of second niche
 * @param {Object} options - Report options
 * @returns {Promise<void>}
 */
async function generateAndRetrieveComparisonReport(niche1Id, niche2Id, options) {
  const {
    outputDir = './reports',
    filename,
    timeframe = 'last_90_days',
    open: shouldOpen = true
  } = options;

  // Validate output directory
  if (!fs.existsSync(outputDir)) {
    try {
      fs.mkdirSync(outputDir, { recursive: true });
      logger.info(`Created output directory: ${outputDir}`);
    } catch (error) {
      logger.error(`Failed to create output directory: ${error.message}`);
      return;
    }
  }

  try {
    // Generate the comparison report
    logger.info(`Generating comparison report for niches ${niche1Id} and ${niche2Id}...`);
    
    const reportResult = await generateNicheComparisonReport(niche1Id, niche2Id, {
      outputDir,
      filename,
      timeframe
    });

    if (reportResult.success) {
      logger.info(`Comparison report generated: ${reportResult.reportPath}`);
      logger.info(`Compared niches: ${reportResult.niche1.name} vs ${reportResult.niche2.name}`);
      
      // Open the report if requested
      if (shouldOpen) {
        try {
          await open(reportResult.reportPath);
          logger.info('Opened report file with default application');
        } catch (openError) {
          logger.warn(`Could not open report file: ${openError.message}`);
          logger.info(`Report is available at: ${reportResult.reportPath}`);
        }
      }
    } else {
      logger.error(`Failed to generate comparison report: ${reportResult.error}`);
    }
  } catch (error) {
    logger.error('An unexpected error occurred while generating the comparison report:', error);
  }
}

/**
 * Retrieves niche data from the database or API
 * 
 * @param {string} nicheId - ID of the niche to retrieve
 * @returns {Promise<Object|null>} - Niche data object or null if not found
 */
async function getNicheData(nicheId) {
  try {
    logger.info(`Retrieving niche data for ID: ${nicheId}`);
    
    // Implementation would connect to database or API
    // This is a placeholder until actual implementation is added
    
    // Simulate a successful retrieval for demonstration
    return {
      niche_name: 'Sample Niche',
      related_keywords: ['keyword1', 'keyword2', 'keyword3'],
      monthly_search_volume: 5000,
      competition_score: 35
    };
  } catch (error) {
    logger.error(`Failed to retrieve niche data: ${error.message}`);
    return null;
  }
}

/**
 * SiteGenie application main function
 */
async function main() {
  // Configure CLI
  program
    .name('sitegenie')
    .description('AI-powered niche website creation and optimization system')
    .version(version);

  // Niche research command
  program
    .command('analyze')
    .description('Analyze niches for profitability and competition')
    .option('-k, --keywords <keywords>', 'Comma-separated keywords to analyze')
    .option('-o, --output <file>', 'Output file for results (JSON format)')
    .option('-l, --limit <number>', 'Limit the number of recommendations', parseInt)
    .action(async (options) => {
      try {
        const keywords = options.keywords ? options.keywords.split(',').map(k => k.trim()) : [];
        logger.info(`Analyzing niches for keywords: ${keywords.join(', ')}`);
        
        const results = await analyzeNiche({
          keywords,
          limit: options.limit || 5
        });
        
        if (options.output) {
          fs.writeFileSync(options.output, JSON.stringify(results, null, 2));
          logger.info(`Results saved to ${options.output}`);
        } else {
          console.log(JSON.stringify(results, null, 2));
        }
      } catch (error) {
        logger.error('Niche analysis failed:', error);
      }
    });

  // Website creation command
  program
    .command('create-site')
    .description('Create a new niche website')
    .requiredOption('-n, --niche <id>', 'Niche ID to use')
    .option('-d, --domain <preferences>', 'Domain name preferences (JSON string)')
    .option('-t, --template <name>', 'Site template to use')
    .action(async (options) => {
      try {
        logger.info(`Creating website for niche ID: ${options.niche}`);
        
        const domainPrefs = options.domain ? JSON.parse(options.domain) : {};
        const result = await createSite(options.niche, {
          domainPreferences: domainPrefs,
          template: options.template
        });
        
        if (result.success) {
          logger.info(`Website created successfully: ${result.domain}`);
          logger.info(`Deployment URL: ${result.deploymentUrl}`);
        } else {
          logger.error(`Website creation failed: ${result.error}`);
        }
      } catch (error) {
        logger.error('Website creation failed:', error);
      }
    });

  // Content generation command
  program
    .command('generate-content')
    .description('Generate content for a website')
    .requiredOption('-s, --site <id>', 'Site ID to generate content for')
    .option('-t, --topic <topic>', 'Topic for the content')
    .option('-k, --keyword <keyword>', 'Primary keyword for the content')
    .option('-w, --words <count>', 'Word count for the content', parseInt)
    .option('-o, --output <file>', 'Output file for content (Markdown format)')
    .action(async (options) => {
      try {
        logger.info(`Generating content for site: ${options.site}`);
        
        const contentBrief = {
          siteId: options.site,
          topic: options.topic || 'Comprehensive Guide',
          primaryKeyword: options.keyword || '',
          wordCount: options.words || 1500,
          sections: ['Introduction', 'Main Content', 'Conclusion'],
          targetAudience: 'General readers'
        };
        
        const result = await createContent(contentBrief);
        
        if (result.status === 'success') {
          logger.info('Content generated successfully');
          logger.info(`Word count: ${result.metrics.wordCount}`);
          
          if (options.output) {
            fs.writeFileSync(options.output, result.content);
            logger.info(`Content saved to ${options.output}`);
          } else {
            console.log(result.content);
          }
        } else {
          logger.error(`Content generation failed: ${result.message}`);
        }
      } catch (error) {
        logger.error('Content generation failed:', error);
      }
    });

  // Report generation command
  program
    .command('report')
    .description('Generate a niche performance report')
    .option('-o, --output-dir <directory>', 'Output directory for the report', './reports')
    .option('-f, --filename <filename>', 'Filename for the report')
    .option('-s, --start-date <date>', 'Start date for report data (YYYY-MM-DD)')
    .option('-e, --end-date <date>', 'End date for report data (YYYY-MM-DD)')
    .option('-m, --metrics <metrics>', 'Comma-separated list of metrics to include')
    .option('--no-open', 'Do not open the report after generation')
    .action(async (options) => {
      await generateAndRetrieveReport(options);
    });

  // Comparison report command
  program
    .command('compare-niches')
    .description('Generate a comparison report between two niches')
    .requiredOption('-n1, --niche1 <id>', 'ID of first niche to compare')
    .requiredOption('-n2, --niche2 <id>', 'ID of second niche to compare')
    .option('-o, --output-dir <directory>', 'Output directory for the report', './reports')
    .option('-f, --filename <filename>', 'Filename for the report')
    .option('-t, --timeframe <period>', 'Timeframe for comparison', 'last_90_days')
    .option('--no-open', 'Do not open the report after generation')
    .action(async (options) => {
      await generateAndRetrieveComparisonReport(options.niche1, options.niche2, {
        outputDir: options.outputDir,
        filename: options.filename,
        timeframe: options.timeframe,
        open: options.open
      });
    });

  // Get niche data command
  program
    .command('get-niche-data')
    .description('Retrieve performance data for all niches')
    .option('-s, --start-date <date>', 'Start date for data (YYYY-MM-DD)')
    .option('-e, --end-date <date>', 'End date for data (YYYY-MM-DD)')
    .option('-m, --metrics <metrics>', 'Comma-separated list of metrics to include')
    .option('-o, --output <file>', 'Output file for data (JSON format)')
    .action(async (options) => {
      try {
        // Parse metrics if provided
        const metricsArray = options.metrics ? options.metrics.split(',').map(m => m.trim()) : undefined;

        // Parse dates if provided
        const startDate = options.startDate ? new Date(options.startDate) : undefined;
        const endDate = options.endDate ? new Date(options.endDate) : undefined;

        // Validate dates
        if (options.startDate && isNaN(startDate.getTime())) {
          logger.error(`Invalid start date: ${options.startDate}`);
          return;
        }

        if (options.endDate && isNaN(endDate.getTime())) {
          logger.error(`Invalid end date: ${options.endDate}`);
          return;
        }

        logger.info('Retrieving niche performance data...');
        
        const result = await getNichePerformanceData({
          startDate,
          endDate,
          metrics: metricsArray
        });

        if (result.success) {
          logger.info(`Retrieved data for ${result.count} niches`);
          
          if (options.output) {
            fs.writeFileSync(options.output, JSON.stringify(result.data, null, 2));
            logger.info(`Data saved to ${options.output}`);
          } else {
            console.log(JSON.stringify(result.data, null, 2));
          }
        } else {
          logger.error(`Failed to retrieve niche data: ${result.error}`);
        }
      } catch (error) {
        logger.error('Failed to retrieve niche data:', error);
      }
    });

  // Domain registration command
  program
    .command('domain')
    .description('Search for or register a domain for a niche')
    .requiredOption('-n, --niche <id>', 'Niche ID to use')
    .option('-s, --search', 'Search for available domains instead of registering')
    .option('-k, --keywords <keywords>', 'Additional comma-separated keywords for domain search')
    .option('-t, --tlds <tlds>', 'Comma-separated list of preferred TLDs')
    .option('-l, --limit <number>', 'Limit number of domain results', parseInt, 10)
    .option('--use-hyphens', 'Include hyphenated domain variations')
    .option('--short-domains', 'Prefer shorter domain names')
    .option('--include-numbers', 'Include domains with numbers')
    .option('-p, --preferences <json>', 'Domain preferences as JSON string (for registration)')
    .action(async (options) => {
      try {
        const nicheId = options.niche;
        
        // Get niche data first
        const nicheData = await getNicheData(nicheId);
        if (!nicheData) {
          logger.error(`Niche with ID ${nicheId} not found`);
          return;
        }
        
        // Handle domain search mode
        if (options.search) {
          logger.info(`Searching for domains related to niche ID: ${nicheId}`);
          
          // Prepare keywords list from niche data and additional keywords
          const nicheKeywords = [nicheData.niche_name];
          
          // Add related keywords from niche
          if (nicheData.related_keywords && nicheData.related_keywords.length > 0) {
            nicheKeywords.push(...nicheData.related_keywords.slice(0, 5));
          }
          
          // Add user-provided keywords if any
          if (options.keywords) {
            const additionalKeywords = options.keywords.split(',').map(k => k.trim());
            nicheKeywords.push(...additionalKeywords);
          }
          
          // Parse preferred TLDs if provided
          const preferredTLDs = options.tlds ? 
            options.tlds.split(',').map(t => t.trim().startsWith('.') ? t.trim() : `.${t.trim()}`) : 
            undefined;
            
          // Perform domain search
          const searchResult = await retrieveDomainSearchResults({
            keywords: nicheKeywords,
            preferredTLDs,
            useHyphens: options.useHyphens || false,
            shortDomains: options.shortDomains || false,
            includeNumbers: options.includeNumbers || false,
            limit: options.limit || 10
          });
          
          if (searchResult.success) {
            logger.info(`Found ${searchResult.count} available domains out of ${searchResult.totalOptions} options`);
            
            // Display domain suggestions
            console.log("\nAvailable Domain Suggestions:");
            console.log("-----------------------------");
            searchResult.suggestions.forEach((domain, index) => {
              console.log(`${index + 1}. ${domain.domain} (Score: ${domain.score.toFixed(1)}${domain.premium ? ' - Premium' : ''})`);
            });
            console.log("\nUse 'sitegenie domain -n <niche-id>' without the --search flag to register a domain.");
          } else {
            logger.error(`Domain search failed: ${searchResult.error}`);
          }
        } else {
          // Domain registration mode
          logger.info(`Registering domain for niche ID: ${nicheId}`);
          
          // Parse domain preferences if provided
          const preferences = options.preferences ? JSON.parse(options.preferences) : {};
          
          // Register the domain
          const result = await registerDomain(nicheData, preferences);
          
          if (result.success) {
            logger.info(`Domain registered successfully: ${result.domain}`);
            logger.info(`Registration date: ${result.registrationDate}`);
            logger.info(`Expiration date: ${result.expirationDate}`);
          } else {
            logger.error(`Domain registration failed: ${result.error}`);
          }
        }
      } catch (error) {
        logger.error('Domain operation failed:', error);
      }
    });

  // Parse arguments
  program.parse(process.argv);

  // Display help if no command provided
  if (!process.argv.slice(2).length) {
    program.outputHelp();
  }
}

// Start application
if (require.main === module) {
  main().catch(error => {
    logger.error('Application failed with error:', error);
    process.exit(1);
  });
}

module.exports = { main, generateAndRetrieveReport, generateAndRetrieveComparisonReport };
