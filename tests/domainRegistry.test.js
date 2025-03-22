/**
 * Tests for the Domain Registry module
 */
const axios = require('axios');
const { 
  registerDomain, 
  generateDomainOptions, 
  checkDomainAvailability, 
  scoreDomain, 
  retrieveDomainSearchResults 
} = require('../src/domainRegistry');

// Mock dependencies
jest.mock('axios');
jest.mock('../src/services/namecheapClient', () => ({
  checkDomainAvailability: jest.fn(),
  registerDomain: jest.fn()
}));
jest.mock('../src/services/cloudflareClient', () => ({
  addZone: jest.fn().mockResolvedValue(true)
}));
jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn()
}));

const namecheapClient = require('../src/services/namecheapClient');

describe('Domain Registry Module', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });
  
  describe('generateDomainOptions', () => {
    test('should generate domain options from a list of keywords', () => {
      // Setup
      const keywords = ['hydroponics', 'gardening'];
      
      // Execute
      const result = generateDomainOptions(keywords);
      
      // Assert
      expect(result).toContain('hydroponics.com');
      expect(result.length).toBeGreaterThan(0);
    });
    
    test('should respect user preferences', () => {
      // Setup
      const keywords = ['hydroponics', 'gardening'];
      const preferences = {
        useHyphens: true,
        preferredTLDs: ['.io', '.net'],
        shortDomains: true
      };
      
      // Execute
      const result = generateDomainOptions(keywords, preferences);
      
      // Assert
      expect(result).toContain('hydroponics.io');
      expect(result).toContain('hydroponics-gardening.io');
      expect(result.some(domain => domain.endsWith('.io'))).toBe(true);
      expect(result.some(domain => domain.endsWith('.net'))).toBe(true);
      expect(result.some(domain => domain.endsWith('.com'))).toBe(false);
    });
    
    test('should handle empty keywords list', () => {
      // Setup
      const keywords = [];
      
      // Execute
      const result = generateDomainOptions(keywords);
      
      // Assert
      expect(result.length).toBe(0);
    });
    
    test('should clean keywords and remove special characters', () => {
      // Setup
      const keywords = ['hydro$ponics!', 'indoor gardening*'];
      
      // Execute
      const result = generateDomainOptions(keywords);
      
      // Assert
      expect(result).toContain('hydroponics.com');
      expect(result.some(domain => domain.includes('$'))).toBe(false);
      expect(result.some(domain => domain.includes('!'))).toBe(false);
    });
  });
  
  describe('scoreDomain', () => {
    test('should score domains based on length and TLD', () => {
      // Execute & Assert
      expect(scoreDomain('short.com')).toBeGreaterThan(scoreDomain('verylongdomainname.com'));
      expect(scoreDomain('domain.com')).toBeGreaterThan(scoreDomain('domain.net'));
      expect(scoreDomain('domain.org')).toBeGreaterThan(scoreDomain('domain.io'));
    });
    
    test('should penalize domains with hyphens', () => {
      // Execute & Assert
      expect(scoreDomain('clean-domain.com')).toBeLessThan(scoreDomain('cleandomain.com'));
    });
    
    test('should penalize domains with numbers', () => {
      // Execute & Assert
      expect(scoreDomain('domain123.com')).toBeLessThan(scoreDomain('domain.com'));
    });
    
    test('should return scores within 0-10 range', () => {
      // Setup - test various domains
      const domains = [
        'short.com',
        'very-long-domain-with-hyphens.org',
        'domain123.net',
        'a.io',
        'thisisareallylongdomainnamethatshouldgetapenalty.com'
      ];
      
      // Execute & Assert
      domains.forEach(domain => {
        const score = scoreDomain(domain);
        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThanOrEqual(10);
      });
    });
  });
  
  describe('checkDomainAvailability', () => {
    test('should return true for available domains', async () => {
      // Setup
      namecheapClient.checkDomainAvailability.mockResolvedValueOnce({
        isAvailable: true
      });
      
      // Execute
      const result = await checkDomainAvailability('available-domain.com');
      
      // Assert
      expect(result).toBe(true);
      expect(namecheapClient.checkDomainAvailability).toHaveBeenCalledWith({
        DomainName: 'available-domain',
        TLD: '.com'
      });
    });
    
    test('should return false for unavailable domains', async () => {
      // Setup
      namecheapClient.checkDomainAvailability.mockResolvedValueOnce({
        isAvailable: false
      });
      
      // Execute
      const result = await checkDomainAvailability('taken-domain.com');
      
      // Assert
      expect(result).toBe(false);
    });
    
    test('should handle API errors gracefully', async () => {
      // Setup
      namecheapClient.checkDomainAvailability.mockRejectedValueOnce(
        new Error('API connection failed')
      );
      
      // Execute
      const result = await checkDomainAvailability('error-domain.com');
      
      // Assert
      expect(result).toBe(false);
    });
  });
  
  describe('retrieveDomainSearchResults', () => {
    test('should retrieve domain search results successfully', async () => {
      // Setup - mock domain availability checks
      namecheapClient.checkDomainAvailability
        .mockResolvedValueOnce({ isAvailable: true })  // First domain available
        .mockResolvedValueOnce({ isAvailable: false }) // Second domain unavailable
        .mockResolvedValueOnce({ isAvailable: true });  // Third domain available
      
      // Execute
      const result = await retrieveDomainSearchResults({
        keywords: ['hydroponics', 'gardening'],
        limit: 5
      });
      
      // Assert
      expect(result.success).toBe(true);
      expect(result.availableDomains.length).toBeLessThanOrEqual(5);
      expect(result.availableDomains.every(d => d.available)).toBe(true);
      // Verify domains are sorted by score
      if (result.availableDomains.length > 1) {
        expect(result.availableDomains[0].score).toBeGreaterThanOrEqual(result.availableDomains[1].score);
      }
    });
    
    test('should return error when no keywords are provided', async () => {
      // Execute
      const result = await retrieveDomainSearchResults({
        keywords: []
      });
      
      // Assert
      expect(result.success).toBe(false);
      expect(result.error).toContain('No keywords provided');
    });
    
    test('should return error when keywords are invalid', async () => {
      // Execute - passing a string instead of array
      const result = await retrieveDomainSearchResults({
        keywords: 'invalid'
      });
      
      // Assert
      expect(result.success).toBe(false);
      expect(result.error).toContain('No keywords provided');
    });
    
    test('should handle API errors during availability checks', async () => {
      // Setup - first domain check succeeds, second throws error
      namecheapClient.checkDomainAvailability
        .mockResolvedValueOnce({ isAvailable: true })
        .mockRejectedValueOnce(new Error('API error'));
      
      // Execute
      const result = await retrieveDomainSearchResults({
        keywords: ['hydroponics', 'gardening'],
        limit: 5
      });
      
      // Assert
      expect(result.success).toBe(true); // Should still succeed overall
      expect(result.availableDomains.length).toBeGreaterThan(0); // Should have at least one valid domain
    });
    
    test('should respect limit parameter', async () => {
      // Setup - all domains are available
      namecheapClient.checkDomainAvailability.mockResolvedValue({ isAvailable: true });
      
      // Execute with small limit
      const result = await retrieveDomainSearchResults({
        keywords: ['hydroponics', 'gardening', 'indoor', 'plants'],
        limit: 3
      });
      
      // Assert
      expect(result.availableDomains.length).toBeLessThanOrEqual(3);
    });
  });
  
  describe('registerDomain', () => {
    const mockNicheData = {
      niche_name: 'indoor hydroponics',
      related_keywords: ['hydroponic gardening', 'indoor plants']
    };
    
    test('should successfully register a domain', async () => {
      // Setup
      namecheapClient.checkDomainAvailability.mockResolvedValue({ isAvailable: true });
      namecheapClient.registerDomain.mockResolvedValueOnce({
        success: true,
        cost: 12.99
      });
      
      // Execute
      const result = await registerDomain(mockNicheData);
      
      // Assert
      expect(result.success).toBe(true);
      expect(result.domain).toBeDefined();
      expect(result.registrationDate).toBeDefined();
      expect(result.expirationDate).toBeDefined();
      expect(namecheapClient.registerDomain).toHaveBeenCalled();
    });
    
    test('should handle case where no domains are available', async () => {
      // Setup - all domains unavailable
      namecheapClient.checkDomainAvailability.mockResolvedValue({ isAvailable: false });
      
      // Execute
      const result = await registerDomain(mockNicheData);
      
      // Assert
      expect(result.success).toBe(false);
      expect(result.error).toContain('No available domains found');
      expect(namecheapClient.registerDomain).not.toHaveBeenCalled();
    });
    
    test('should handle registration failure', async () => {
      // Setup - domain is available but registration fails
      namecheapClient.checkDomainAvailability.mockResolvedValue({ isAvailable: true });
      namecheapClient.registerDomain.mockResolvedValueOnce({
        success: false,
        error: 'Registration failed'
      });
      
      // Execute
      const result = await registerDomain(mockNicheData);
      
      // Assert
      expect(result.success).toBe(false);
      expect(result.error).toContain('Domain registration failed');
      expect(result.attempted_domain).toBeDefined();
    });
    
    test('should handle unexpected errors', async () => {
      // Setup - domain availability check throws error
      namecheapClient.checkDomainAvailability.mockRejectedValue(new Error('Unexpected API error'));
      
      // Execute
      const result = await registerDomain(mockNicheData);
      
      // Assert
      expect(result.success).toBe(false);
      expect(result.error).toContain('Domain registration error');
      expect(result.details).toBeDefined(); // Should include error stack
    });
  });
});
