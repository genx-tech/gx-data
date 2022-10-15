CREATE TABLE IF NOT EXISTS `party` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `preferredName` VARCHAR(200) NOT NULL DEFAULT "",
  `website` VARCHAR(750) NULL,
  `logo` VARCHAR(750) NULL,
  `avatar` VARCHAR(750) NULL,
  `about` TEXT NULL,
  `createdAt` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,
  `isDeleted` TINYINT(1) NOT NULL DEFAULT 0,
  `deletedAt` DATETIME NULL,
  `type` VARCHAR(64) NOT NULL DEFAULT "",
  `company` INT NULL,
  `person` INT NULL,
  PRIMARY KEY (`id`)
);

CREATE TABLE IF NOT EXISTS `partyType` (
  `code` VARCHAR(64) NOT NULL DEFAULT "",
  `name` VARCHAR(200) NOT NULL DEFAULT "",
  `indexOrder` INT NOT NULL DEFAULT 0,
  `desc` TEXT NULL,
  `isSystem` TINYINT(1) NULL,
  `isActive` TINYINT(1) NOT NULL DEFAULT 1,
  `usage` VARCHAR(60) NULL,
  `isDeleted` TINYINT(1) NOT NULL DEFAULT 0,
  `deletedAt` DATETIME NULL,
  PRIMARY KEY (`code`),
  UNIQUE KEY (`name`)
);

CREATE TABLE IF NOT EXISTS `company` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(200) NOT NULL DEFAULT "",
  `logo` VARCHAR(750) NULL,
  `avatar` VARCHAR(750) NULL,
  `website` VARCHAR(750) NULL,
  `about` TEXT NULL,
  `registrationNo` VARCHAR(60) NULL,
  `email` VARCHAR(200) NULL,
  `phone` VARCHAR(20) NULL,
  `mobile` VARCHAR(20) NULL,
  `fax` VARCHAR(20) NULL,
  `abn` CHAR(11) NULL,
  `acn` CHAR(9) NULL,
  `taxIdNumber` VARCHAR(60) NULL,
  `createdAt` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,
  `isDeleted` TINYINT(1) NOT NULL DEFAULT 0,
  `deletedAt` DATETIME NULL,
  `role` VARCHAR(64) NOT NULL DEFAULT "",
  PRIMARY KEY (`id`),
  KEY (`name`),
  KEY (`registrationNo`)
);

CREATE TABLE IF NOT EXISTS `person` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `firstName` VARCHAR(200) NULL,
  `middleName` VARCHAR(200) NULL,
  `lastName` VARCHAR(200) NULL,
  `legalName` VARCHAR(200) NULL,
  `dob` DATETIME NULL,
  `maritalStatus` ENUM('single', 'married', 'divorced', 'widowed', 'de facto') NULL,
  `gender` ENUM('male', 'female', 'non-disclosure') NULL,
  `residencyStatus` ENUM('citizen', 'pr', 'overseas') NULL,
  `createdAt` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,
  `isDeleted` TINYINT(1) NOT NULL DEFAULT 0,
  `deletedAt` DATETIME NULL,
  `title` VARCHAR(100) NULL,
  `contact` INT NULL,
  PRIMARY KEY (`id`),
  KEY (`lastName`),
  KEY (`legalName`)
);

CREATE TABLE IF NOT EXISTS `contact` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `mobile` VARCHAR(20) NULL,
  `phone` VARCHAR(20) NULL,
  `email` VARCHAR(200) NULL,
  PRIMARY KEY (`id`)
);

CREATE TABLE IF NOT EXISTS `companyRole` (
  `code` VARCHAR(64) NOT NULL DEFAULT "",
  `name` VARCHAR(200) NOT NULL DEFAULT "",
  `indexOrder` INT NOT NULL DEFAULT 0,
  `desc` TEXT NULL,
  `isSystem` TINYINT(1) NULL,
  `isActive` TINYINT(1) NOT NULL DEFAULT 1,
  `isDeleted` TINYINT(1) NOT NULL DEFAULT 0,
  `deletedAt` DATETIME NULL,
  PRIMARY KEY (`code`),
  UNIQUE KEY (`name`)
);

CREATE TABLE IF NOT EXISTS `companyContact` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `main` TINYINT(1) NOT NULL DEFAULT 0,
  `company` INT NOT NULL DEFAULT 0,
  `person` INT NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  UNIQUE KEY (`company`, `person`)
);

CREATE TABLE IF NOT EXISTS `personTitle` (
  `code` VARCHAR(100) NOT NULL DEFAULT "",
  `name` VARCHAR(200) NOT NULL DEFAULT "",
  `male` TINYINT(1) NOT NULL DEFAULT 0,
  `female` TINYINT(1) NOT NULL DEFAULT 0,
  PRIMARY KEY (`code`)
);

