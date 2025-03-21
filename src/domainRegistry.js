/**
 * SiteGenie Domain Registry Module
 * Handles domain name generation, availability checking, and registration
 */
const axios = require('axios');
const logger = require('./utils/logger'); // Assuming a logger utility exists

// Configure API clients for domain registrars
const namecheapClient = require('./services/namecheapClient'); // Assuming this exists
const cloudflareClient = require('./services/cloudflareClient'); // For DNS management

/**
 * Generates domain name options based on a list of keywords and user preferences
 * 
 * @param {Array<string>} keywordsList - List of keywords to use for domain generation
 * @param {Object} preferences - User preferences for domain generation
 * @param {boolean} [preferences.useHyphens=false] - Whether to use hyphens between words
 * @param {Array<string>} [preferences.preferredTLDs] - List of preferred TLDs
 * @param {boolean} [preferences.shortDomains=false] - Preference for shorter domains
 * @param {boolean} [preferences.includeNumbers=false] - Whether to include numbers in domain names
 * @returns {Array<string>} - List of domain name options
 */
function generateDomainOptions(keywordsList, preferences = {}) {
  // Default preferences
  const {
    useHyphens = false,
    preferredTLDs = ['.com', '.org', '.net', '.io'],
    shortDomains = false,
    includeNumbers = false
  } = preferences;

  const domainOptions = [];
  const maxDomainLength = 63; // DNS standard max length for a single label

  // Clean and prepare keywords
  const cleanedKeywords = keywordsList.map(keyword => 
    keyword.toLowerCase()
      .replace(/[^\w\s-]/g, '') // Remove special characters except hyphens
      .trim()
  ).filter(keyword => keyword.length > 0);

  // Generate variations from main niche keyword
  const mainKeyword = cleanedKeywords[0];

  // Main keyword with different TLDs
  for (const tld of preferredTLDs) {
    if (mainKeyword.length <= maxDomainLength) {
      domainOptions.push(`${mainKeyword}${tld}`);
    }
  }

  // Combinations of keywords
  for (let i = 0; i < Math.min(cleanedKeywords.length, 3); i++) {
    for (let j = i + 1; j < Math.min(cleanedKeywords.length, 4); j++) {
      // Skip if keywords are too similar
      if (cleanedKeywords[i] === cleanedKeywords[j]) continue;
      
      // Create combinations
      const combinations = [];
      
      // Standard combination
      combinations.push(`${cleanedKeywords[i]}${cleanedKeywords[j]}`);
      
      // With hyphens if preferred
      if (useHyphens) {
        combinations.push(`${cleanedKeywords[i]}-${cleanedKeywords[j]}`);
      }
      
      // With "and" connector
      combinations.push(`${cleanedKeywords[i]}and${cleanedKeywords[j]}`);
      
      // With numbers if preferred
      if (includeNumbers) {
        combinations.push(`${cleanedKeywords[i]}${Math.floor(Math.random() * 100)}`);
        combinations.push(`${cleanedKeywords[i]}${cleanedKeywords[j]}${Math.floor(Math.random() * 10)}`);
      }
      
      // Add TLDs to valid combinations
      for (const combo of combinations) {
        if (combo.length <= maxDomainLength) {
          for (const tld of preferredTLDs) {
            domainOptions.push(`${combo}${tld}`);
          }
        }
      }
    }
  }

  // Add "best" or "top" prefix to main keyword
  const prefixes = ['best', 'top', 'my', 'the'];
  for (const prefix of prefixes) {
    const prefixedDomain = `${prefix}${mainKeyword}`;
    if (prefixedDomain.length <= maxDomainLength) {
      for (const tld of preferredTLDs) {
        domainOptions.push(`${prefixedDomain}${tld}`);
      }
    }
  }

  // Add "guide", "hub", "pro" suffixes to main keyword
  const suffixes = ['guide', 'hub', 'pro', 'expert', 'hq'];
  for (const suffix of suffixes) {
    const suffixedDomain = `${mainKeyword}${suffix}`;
    if (suffixedDomain.length <= maxDomainLength) {
      for (const tld of preferredTLDs) {
        domainOptions.push(`${suffixedDomain}${tld}`);
      }
    }
  }

  // If short domains are preferred, filter out longer options
  if (shortDomains) {
    return domainOptions
      .filter(domain => domain.split('.')[0].length <= 15)
      .slice(0, 20);
  }

  // Return unique domains, limiting to 25 options
  return [...new Set(domainOptions)].slice(0, 25);
}

/**
 * Checks if a domain is available for registration
 * 
 * @param {string} domain - Domain name to check
 * @returns {Promise<boolean>} - True if domain is available
 */
async function checkDomainAvailability(domain) {
  try {
    const domainParts = domain.split('.');
    const domainName = domainParts[0];
    const tld = `.${domainParts[1]}`;
    
    const result = await namecheapClient.checkDomainAvailability({
      DomainName: domainName,
      TLD: tld
    });
    
    return result.isAvailable === true;
  } catch (error) {
    logger.error(`Error checking domain availability for ${domain}:`, error);
    return false;
  }
}

/**
 * Scores a domain based on length, keyword inclusion, and memorability
 * 
 * @param {string} domain - Domain name to score
 * @returns {number} - Score from 0-10
 */
function scoreDomain(domain) {
  const domainName = domain.split('.')[0];
  const tld = domain.split('.')[1];
  
  let score = 5; // Start with midpoint
  
  // Length score - domains between 6-14 characters are ideal
  const length = domainName.length;
  if (length <= 5) {
    score += 2; // Very short domains are premium
  } else if (length <= 10) {
    score += 1.5; // Ideal length
  } else if (length <= 15) {
    score += 1; // Good length
  } else if (length > 20) {
    score -= 1; // Too long
  }
  
  // TLD score - .com is preferred
  if (tld === 'com') {
    score += 2;
  } else if (['org', 'net'].includes(tld)) {
    score += 1;
  } else if (['io', 'co'].includes(tld)) {
    score += 0.5;
  }
  
  // Hyphen penalty
  if (domainName.includes('-')) {
    score -= 0.5;
  }
  
  // Number penalty
  if (/\d/.test(domainName)) {
    score -= 0.5;
  }
  
  // Memorability - avoid double letters and hard-to-spell patterns
  if (/([a-z])\1/.test(domainName)) {
    score -= 0.3; // Double letters
  }
  
  // Pronounceability - estimate based on consonant-to-vowel ratio
  const consonants = (domainName.match(/[bcdfghjklmnpqrstvwxyz]/g) || []).length;
  const vowels = (domainName.match(/[aeiou]/g) || []).length;
  
  // Ideal ratio is around 1.5-2 consonants per vowel
  const ratio = consonants / (vowels || 1);
  if (ratio >= 1 && ratio <= 2.5) {
    score += 1;
  } else if (ratio > 2.5) {
    score -= 0.5; // Too many consonants, hard to pronounce
  }
  
  // Ensure score stays within 0-10 range
  return Math.max(0, Math.min(10, score));
}

/**
 * Registers a domain based on niche data and user preferences
 * 
 * @param {Object} nicheData - Data about the niche
 * @param {string} nicheData.niche_name - Name of the niche
 * @param {Array} nicheData.related_keywords - Related keywords for the niche
 * @param {Object} preferences - User preferences for domain selection
 * @returns {Promise<Object>} - Registration result information
 */
async function registerDomain(nicheData, preferences = {}) {
  try {
    // Generate domain name options based on niche keywords
    const keywordsList = [
      nicheData.niche_name,
      ...nicheData.related_keywords.slice(0, 5)
    ];
    
    const domainOptions = generateDomainOptions(keywordsList, preferences);
    
    // Check domain availability in parallel
    logger.info(`Checking availability for ${domainOptions.length} domain options`);
    const availabilityChecks = await Promise.all(
      domainOptions.map(async (domain) => {
        const available = await checkDomainAvailability(domain);
        return { domain, available, score: available ? scoreDomain(domain) : 0 };
      })
    );
    
    // Filter available domains and sort by score
    const availableDomains = availabilityChecks
      .filter(d => d.available)
      .sort((a, b) => b.score - a.score);
    
    if (availableDomains.length === 0) {
      return { success: false, error: 'No available domains found' };
    }
    
    // Register the highest-scoring domain
    const domainToRegister = availableDomains[0].domain;
    const domainParts = domainToRegister.split('.');
    
    logger.info(`Registering domain: ${domainToRegister} (score: ${availableDomains[0].score})`);
    
    const registrationResult = await namecheapClient.registerDomain({
      DomainName: domainParts[0],
      TLD: `.${domainParts[1]}`,
      Years: 1,
      Nameservers: 'ns1.cloudflare.com,ns2.cloudflare.com'
    });
    
    if (registrationResult.success) {
      // Configure DNS with Cloudflare
      await cloudflareClient.addZone(domainToRegister);
      
      // Return success response
      return {
        success: true,
        domain: domainToRegister,
        registrationDate: new Date().toISOString(),
        expirationDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
        nameservers: ['ns1.cloudflare.com', 'ns2.cloudflare.com'],
        domainScore: availableDomains[0].score,
        registrationCost: registrationResult.cost || 12.99
      };
    } else {
      return {
        success: false,
        error: `Domain registration failed: ${registrationResult.error || 'Unknown error'}`,
        attempted_domain: domainToRegister
      };
    }
  } catch (error) {
    logger.error('Error registering domain:', error);
    return {
      success: false,
      error: `Domain registration error: ${error.message}`,
      details: error.stack
    };
  }
}

module.exports = {
  registerDomain,
  generateDomainOptions,
  checkDomainAvailability,
  scoreDomain
};
